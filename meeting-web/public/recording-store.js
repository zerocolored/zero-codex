/** A saved chunk and its contiguous-count watermark are one durable transaction. */
export function persistRecordingChunk(db, key, meta, chunk) {
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['chunks','meta'],'readwrite')
    const saved={...meta,count:chunk.seq+1}
    tx.objectStore('chunks').put(chunk,`${chunk.room}:${chunk.seq}`)
    tx.objectStore('meta').put(saved,key)
    tx.oncomplete=()=>resolve(saved.count)
    tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Recording transaction aborted'))
  })
}

/** Repair historical stale metadata from actual bytes; never certify a gap. */
export function recoverRecordingCount(chunks) {
  const ordered=[...chunks].sort((a,b)=>a.seq-b.seq)
  if(ordered.some((chunk,index)=>chunk.seq!==index))throw new Error('録画に欠落があります。残っている録画を保持するためページを閉じないでください')
  return ordered.length
}

/** Web Locks are released by the browser when the owning tab dies, without time-based stealing. */
export function acquireRecordingTab(locks,room) {
  if(!locks)return Promise.reject(new Error('録画の排他制御に対応したChromeまたはEdgeで開いてください'))
  return new Promise((resolve,reject)=>{
    locks.request(`zero-hearing:${room}`,{ifAvailable:true},async lock=>{
      if(!lock){resolve(null);return}
      await new Promise(release=>resolve(release))
    }).catch(reject)
  })
}
