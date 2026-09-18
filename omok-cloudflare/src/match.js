// Queue lives in hibernation-safe socket attachments on one dedicated GameRoom object.
export function matchMessage(room,ws,m){
 const a=ws.deserializeAttachment();
 if(m.type==='cancel'){ws.serializeAttachment({...a,queued:false});ws.send(JSON.stringify({type:'cancelled'}));ws.close(1000,'대기 취소');return;}
 if(m.type==='ping'){ws.serializeAttachment({...a,seen:Date.now()});return;}
 if(m.type!=='queue'||a.queued||a.matched)return;
 if(typeof m.token!=='string'||!/^[a-f0-9-]{36}$/.test(m.token)){ws.close(1008,'잘못된 접속 정보');return;}
 for(const other of room.sockets()){
  const b=other.deserializeAttachment();
  if(other!==ws&&b?.kind==='match'&&b.token===m.token&&other.readyState===1){ws.send(JSON.stringify({type:'error',message:'이미 빠른 대전 대기 중입니다.',fatal:true}));ws.close(1008,'중복 대기');return;}
 }
 const entry={...a,token:m.token,queued:true,seen:Date.now()};ws.serializeAttachment(entry);
 const opponent=room.sockets().find(other=>{const b=other.deserializeAttachment();return other!==ws&&other.readyState===1&&b?.kind==='match'&&b.queued&&b.token!==m.token&&Date.now()-b.seen<30000;});
 if(!opponent){ws.send(JSON.stringify({type:'queued'}));return;}
 const code=crypto.randomUUID().replaceAll('-','').toUpperCase();
 const b=opponent.deserializeAttachment();
 // Claim both entries before sending either notification; no awaits in this operation.
 opponent.serializeAttachment({...b,queued:false,matched:true});ws.serializeAttachment({...entry,queued:false,matched:true});
 const payload=JSON.stringify({type:'matched',code});
 try{opponent.send(payload);ws.send(payload);}catch{for(const s of [opponent,ws])try{s.send(JSON.stringify({type:'error',message:'상대 연결이 끊겼습니다. 빠른 대전을 다시 눌러 주세요.',fatal:true}));}catch{}}
 for(const s of [opponent,ws])try{s.close(1000,'매칭 완료');}catch{}
}
