import {matchMessage} from './match.js';
export const emptyState = () => ({players:[],board:Array(225).fill(0),turn:0,status:'waiting',winner:null,rematch:[],lastMove:null,starter:0});
export class GameRoom {
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.state=emptyState();this.tokens={};ctx.blockConcurrencyWhile(async()=>{const saved=await ctx.storage.get('game');if(saved){this.state=saved.state;this.tokens=saved.tokens;}});}
 sockets(){return this.ctx.getWebSockets();}
 online(id){return this.sockets().some(ws=>ws.deserializeAttachment()?.id===id && ws.readyState===1);}
 async save(){await this.ctx.storage.put('game',{state:this.state,tokens:this.tokens});}
 error(ws,message,fatal=false){ws.send(JSON.stringify({type:'error',message,fatal}));if(fatal)ws.close(1008,message);}
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/lobby-update'&&request.method==='POST'){
   const x=await request.json();let rooms=await this.ctx.storage.get('rooms')||{};
   if(x.remove)delete rooms[x.code];else rooms[x.code]={code:x.code,players:x.players||0,status:x.status||'waiting',at:Date.now()};
   const now=Date.now();for(const k in rooms)if(now-rooms[k].at>7200000)delete rooms[k];
   await this.ctx.storage.put('rooms',rooms);this.broadcastLobby(rooms);return new Response('ok');
  }
  if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});
  const matchmaking=path==='/match',lobby=path==='/lobby';if(path.startsWith('/room/'))this.roomCode=path.slice(6).toUpperCase();
  if(this.sockets().length>=((matchmaking||lobby)?500:8))return new Response('Too many connections',{status:429});
  const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1]);pair[1].serializeAttachment({id:null,at:Date.now(),count:0,kind:lobby?'lobby':matchmaking?'match':'game'});if(lobby)setTimeout(()=>this.sendLobby(pair[1]),0);
  return new Response(null,{status:101,webSocket:pair[0]});
 }
 async webSocketMessage(ws,data){
  if(typeof data!=='string'||data.length>2048)return this.error(ws,'잘못된 요청입니다.',true);
  let m;try{m=JSON.parse(data);}catch{return this.error(ws,'잘못된 요청입니다.');}
  if(!m||typeof m!=='object')return;
  let a=ws.deserializeAttachment()||{id:null,at:Date.now(),count:0};
  if(Date.now()-a.at>1000){a.at=Date.now();a.count=0;}a.count++;ws.serializeAttachment(a);if(a.count>20)return this.error(ws,'요청이 너무 빠릅니다.');
  if(a.kind==='lobby'){if(m.type==='ping')ws.serializeAttachment({...a,seen:Date.now()});return;}
  if(a.kind==='match')return matchMessage(this,ws,m);
  if(m.type==='join'){
   if(a.id)return;
   if(typeof m.token!=='string'||! /^[a-f0-9-]{36}$/.test(m.token))return this.error(ws,'접속 정보가 잘못되었습니다.',true);
   let p=this.state.players.find(p=>this.tokens[p.id]===m.token);
   if(!p){
    if(this.state.players.length===2)return this.error(ws,'방이 가득 찼습니다. 새 방을 만들어 주세요.',true);
    p={id:crypto.randomUUID(),name:String(m.name||'밀레시안').trim().slice(0,12)||'밀레시안',char:[1,2,3,4].find(c=>!this.state.players.some(x=>x.char===c))};
    this.state.players.push(p);this.tokens[p.id]=m.token;
   }
   for(const old of this.sockets())if(old!==ws&&old.deserializeAttachment()?.id===p.id){old.serializeAttachment({id:null});old.close(4001,'다른 창에서 접속했습니다.');}
   a.id=p.id;ws.serializeAttachment(a);
   if(this.state.players.length===2&&this.state.status==='waiting'){this.state.status='playing';this.state.starter=Math.floor(Math.random()*2);this.state.turn=this.state.starter;}
   await this.save();ws.send(JSON.stringify({type:'identity',id:p.id}));this.broadcast();this.updateLobby();return;
  }
  const pi=this.state.players.findIndex(p=>p.id===a.id);if(pi<0)return this.error(ws,'먼저 입장해 주세요.');
  if(m.type==='move'){
   if(this.state.status!=='playing'||this.state.players.length!==2||!this.state.players.every(p=>this.online(p.id)))return;
   const i=m.index;if(pi!==this.state.turn||!Number.isInteger(i)||i<0||i>=225||this.state.board[i])return;
   this.state.board[i]=pi+1;this.state.lastMove=i;
   if(this.win(i,pi+1)){this.state.status='won';this.state.winner=a.id;}
   else if(this.state.board.every(Boolean))this.state.status='draw';else this.state.turn=1-pi;
  }else if(m.type==='rematch'){
   if(!['won','draw'].includes(this.state.status))return;
   if(!this.state.rematch.includes(a.id))this.state.rematch.push(a.id);
   if(this.state.rematch.length===2){const players=this.state.players;const starter=1-this.state.starter;this.state={...emptyState(),players,starter,turn:starter,status:'playing'};}
  }else if(m.type==='leave'){
   const id=a.id;this.state.players=this.state.players.filter(p=>p.id!==id);delete this.tokens[id];this.state={...emptyState(),players:this.state.players};ws.serializeAttachment({id:null});ws.close(1000,'퇴장');
  }else return;
  await this.save();this.broadcast();this.updateLobby();
 }
 win(i,v){const r=Math.floor(i/15),c=i%15;for(const [dr,dc] of [[1,0],[0,1],[1,1],[1,-1]]){let n=1;for(const s of [-1,1]){let rr=r+dr*s,cc=c+dc*s;while(rr>=0&&rr<15&&cc>=0&&cc<15&&this.state.board[rr*15+cc]===v){n++;rr+=dr*s;cc+=dc*s;}}if(n>=5)return true;}return false;}
 async updateLobby(){try{const code=this.roomCode;if(!this.env?.GAME_ROOM||!code)return;const hub=this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName('__quick_match_v1__'));await hub.fetch(new Request('https://internal/lobby-update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,players:this.state.players.length,status:this.state.status,remove:this.state.players.length===0})}));}catch{}}
 async sendLobby(ws){try{let rooms=await this.ctx.storage.get('rooms')||{};const list=Object.values(rooms).filter(r=>Date.now()-r.at<7200000&&r.players<2);ws.send(JSON.stringify({type:'lobby',online:this.sockets().filter(s=>s.deserializeAttachment()?.kind==='lobby').length,rooms:list}));}catch{}}
 async broadcastLobby(rooms){const list=Object.values(rooms).filter(r=>Date.now()-r.at<7200000&&r.players<2),msg=JSON.stringify({type:'lobby',online:this.sockets().filter(s=>s.deserializeAttachment()?.kind==='lobby').length,rooms:list});for(const s of this.sockets())if(s.deserializeAttachment()?.kind==='lobby')try{s.send(msg)}catch{}}
 async webSocketClose(ws){if(ws.deserializeAttachment()?.kind==='lobby'){ws.serializeAttachment({kind:'lobby',closed:true});const rooms=await this.ctx.storage.get('rooms')||{};this.broadcastLobby(rooms);return;}if(ws.deserializeAttachment()?.kind==='match'){ws.serializeAttachment({kind:'match',queued:false});return;}ws.serializeAttachment({id:null});this.broadcast();}
 async webSocketError(ws){if(ws.deserializeAttachment()?.kind==='match'){ws.serializeAttachment({kind:'match',queued:false});try{ws.close(1011,'연결 오류');}catch{}return;}ws.serializeAttachment({id:null});try{ws.close(1011,'연결 오류');}catch{}this.broadcast();}
 broadcast(){const state={...this.state,players:this.state.players.map(p=>({...p,online:this.online(p.id)}))};const msg=JSON.stringify({type:'state',state});for(const ws of this.sockets())if(ws.deserializeAttachment()?.id)try{ws.send(msg);}catch{}}
}
