import {test,expect} from 'bun:test'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
class Element {
 textContent='';hidden=false;className='';dataset:Record<string,string>={};dateTime='';children:Element[]=[]
 append(...nodes:Element[]){this.children.push(...nodes)}
 replaceChildren(...nodes:Element[]){this.children=nodes}
 addEventListener(){}
}
async function dashboard(instances:any[],hidden=2){
 let now=Date.parse('2026-09-27T00:00:00Z')
 const elements=new Map<string,Element>()
 const get=(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!}
 const document={getElementById:get,createElement:()=>new Element()}
 const clock=class extends Date{static now(){return now}}
 const context:any={document,Date:clock,AbortSignal,setInterval:()=>0,fetch:async()=>Response.json({serverTime:new Date(now).toISOString(),instances,hidden})}
 runInNewContext(readFileSync(new URL('../fleet-web/public/app.js',import.meta.url),'utf8'),context)
 await new Promise(resolve=>setImmediate(resolve))
 return {get,context,advance(ms:number){now+=ms;context.render()},names:()=>get('rows').children.map(r=>r.children[0]?.children[0]?.textContent),states:()=>get('rows').children.map(r=>r.children[1]?.children[0]?.textContent)}
}
function row(name:string,age:number,connected=true,runner=true,installation=name){return {id:name,name,pc:name,appId:name,teamId:'T',installationId:installation,receivedAt:new Date(Date.parse('2026-09-27T00:00:00Z')-age).toISOString(),snapshot:{state:'available',project:'demo',queued:0,slackConnected:connected,runnerHealthy:runner}}}
test('dashboard puts online first, keeps offline rows, and preserves order within groups',async()=>{
 const d=await dashboard([row('A-stale',100000),row('B-online',1000),row('C-disconnected',1000,false),row('D-online',2000),row('E-runner-down',1000,true,false)])
 expect(d.names()).toEqual(['B-online','D-online','A-stale','C-disconnected','E-runner-down'])
 expect(d.states()).toEqual(['すぐ着手可能','すぐ着手可能','状態不明','状態不明','状態不明'])
 expect(d.get('total').textContent).toBe('5台')
 expect(d.get('counts').children.map(e=>e.children[1].textContent)).toEqual(['2','0','0','3'])
 expect(d.get('hidden-note').textContent).toContain('未起動の登録 2件')
})
test('dashboard reorders when a heartbeat becomes stale, without mutating API order',async()=>{
 const instances=[row('A',89000),row('B',1000),row('C',120000)]
 const d=await dashboard(instances)
 expect(d.names()).toEqual(['A','B','C'])
 d.advance(1000)
 expect(d.names()).toEqual(['B','A','C'])
 expect(instances.map(r=>r.name)).toEqual(['A','B','C'])
})
test('real simultaneous same-app instances remain visible and warn, disconnected peer does not force online peer unknown',async()=>{
 const a=row('A',1000),b={...row('B',1000),appId:'A'},c={...row('C',1000,false),appId:'D'},d=row('D',1000)
 const ui=await dashboard([a,b,c,d])
 expect(ui.names()).toEqual(['A','B','D','C'])
 expect(ui.states()).toEqual(['状態不明','状態不明','すぐ着手可能','状態不明'])
})
test('empty list and absent hidden count remain valid',async()=>{
 const d=await dashboard([],0)
 expect(d.get('total').textContent).toBe('0台')
 expect(d.get('rows').children[0].textContent).toBe('プロジェクトで起動したZeroちゃんはまだありません。')
 expect(d.get('hidden-note').hidden).toBe(true)
})
test('null and invalid report timestamps sort below healthy online rows',async()=>{
 const missing={...row('A',0),receivedAt:null},invalid={...row('B',0),receivedAt:'invalid'}
 const d=await dashboard([missing,invalid,row('C',0)])
 expect(d.names()).toEqual(['C','A','B'])
 expect(d.states()).toEqual(['すぐ着手可能','状態不明','状態不明'])
})

test('Slack-connected peer with a failed runner still warns about duplicate receivers',async()=>{
 const a=row('A',1000),b={...row('B',1000,true,false),appId:'A'}
 const ui=await dashboard([b,a])
 expect(ui.names()).toEqual(['A','B'])
 expect(ui.states()).toEqual(['状態不明','状態不明'])
 expect(ui.get('rows').children[0].children[1].children[1].textContent).toBe('同じアプリが別PCでも稼働中')
})
