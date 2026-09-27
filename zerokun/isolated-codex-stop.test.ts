import {test,expect} from 'bun:test'
import {stopIsolatedCodexProcesses,runIsolatedCodexJson} from './slack-thread-intent.ts'
test('shutdown forbids late dedicated and queued classifier spawns before resolving executable',async()=>{
 await stopIsolatedCodexProcesses()
 for(const independent of [true,false]) await expect(runIsolatedCodexJson('not sent',{}, {independent})).rejects.toThrow('stopping')
})
