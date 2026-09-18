import {matchMessage} from './match.js';
export const emptyState = () => ({players:[],board:Array(225).fill(0),turn:0,status:'waiting',winner:null,rematch:[],lastMove:null,starter:0,black:0,rule:'renju'});
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
   if(this.state.players.length===2&&this.state.status==='waiting'){this.state.status='playing';this.state.black=this.state.black??0;this.state.starter=this.state.black;this.state.turn=this.state.black;}
   await this.save();ws.send(JSON.stringify({type:'identity',id:p.id}));this.broadcast();this.updateLobby();return;
  }
  const pi=this.state.players.findIndex(p=>p.id===a.id);if(pi<0)return this.error(ws,'먼저 입장해 주세요.');
  if(m.type==='move'){
   if(this.state.status!=='playing'||this.state.players.length!==2||!this.state.players.every(p=>this.online(p.id)))return;
   const i=m.index;if(pi!==this.state.turn||!Number.isInteger(i)||i<0||i>=225||this.state.board[i])return;
   const black=this.state.black??0;
   if(pi===black&&this.state.board.every(x=>!x)&&i!==112)return this.error(ws,'렌주룰: 흑의 첫 수는 정중앙에 두어야 합니다.');
   this.state.board[i]=pi+1;this.state.lastMove=i;
   if(pi===black){
    const result=this.blackResult(i,pi+1);
    if(!result.legal){this.state.board[i]=0;this.state.lastMove=null;return this.error(ws,'금수: '+result.reason);}
    if(result.win){this.state.status='won';this.state.winner=a.id;}
    else if(this.state.board.every(Boolean))this.state.status='draw';else this.state.turn=1-pi;
   }else{
    if(this.fiveOrMore(i,pi+1)){this.state.status='won';this.state.winner=a.id;}
    else if(this.state.board.every(Boolean))this.state.status='draw';else this.state.turn=1-pi;
   }
  }else if(m.type==='rematch'){
   if(!['won','draw'].includes(this.state.status))return;
   if(!this.state.rematch.includes(a.id))this.state.rematch.push(a.id);
   if(this.state.rematch.length===2){const players=this.state.players;const black=1-(this.state.black??0);this.state={...emptyState(),players,black,starter:black,turn:black,status:'playing'};}
  }else if(m.type==='leave'){
   const id=a.id;this.state.players=this.state.players.filter(p=>p.id!==id);delete this.tokens[id];this.state={...emptyState(),players:this.state.players};ws.serializeAttachment({id:null});ws.close(1000,'퇴장');
  }else return;
  await this.save();this.broadcast();this.updateLobby();
 }
 dirs(){return [[1,0],[0,1],[1,1],[1,-1]];}
 pos(i,dr,dc,k){const r=Math.floor(i/15)+dr*k,c=i%15+dc*k;return r>=0&&r<15&&c>=0&&c<15?r*15+c:-1;}
 run(i,v,dr,dc){let n=1;for(const s of [-1,1])for(let k=1;;k++){const p=this.pos(i,dr,dc,k*s);if(p<0||this.state.board[p]!==v)break;n++;}return n;}
 exactFive(i,v){return this.dirs().some(([dr,dc])=>this.run(i,v,dr,dc)===5);}
 fiveOrMore(i,v){return this.dirs().some(([dr,dc])=>this.run(i,v,dr,dc)>=5);}
 overline(i,v){return this.dirs().some(([dr,dc])=>this.run(i,v,dr,dc)>=6);}
 fourCount(i,v){
  const groups=new Set();
  for(const [dr,dc] of this.dirs())for(let start=-4;start<=0;start++){
   const ps=[];let ok=true;for(let k=0;k<5;k++){const p=this.pos(i,dr,dc,start+k);if(p<0){ok=false;break}ps.push(p)}if(!ok)continue;
   const vals=ps.map(p=>this.state.board[p]);if(vals.filter(x=>x===v).length!==4||vals.filter(x=>x===0).length!==1)continue;
   const e=ps[vals.indexOf(0)];this.state.board[e]=v;const valid=this.run(e,v,dr,dc)===5;this.state.board[e]=0;if(!valid)continue;
   groups.add(ps.filter(p=>this.state.board[p]===v).sort((a,b)=>a-b).join(','));
  }
  return groups.size;
 }
 threeCount(i,v,depth=0){
  const groups=new Set();
  for(const [dr,dc] of this.dirs())for(let start=-3;start<=0;start++){
   const ps=[];let ok=true;for(let k=0;k<4;k++){const p=this.pos(i,dr,dc,start+k);if(p<0){ok=false;break}ps.push(p)}if(!ok)continue;
   const vals=ps.map(p=>this.state.board[p]);if(vals.filter(x=>x===v).length!==3||vals.filter(x=>x===0).length!==1)continue;
   const before=this.pos(i,dr,dc,start-1),after=this.pos(i,dr,dc,start+4);if(before<0||after<0||this.state.board[before]||this.state.board[after])continue;
   const e=ps[vals.indexOf(0)],key=ps.filter(p=>this.state.board[p]===v).sort((a,b)=>a-b).join(',');
   this.state.board[e]=v;
   let straight=this.run(e,v,dr,dc)===4;
   if(straight){for(const end of [before,after]){this.state.board[end]=v;if(this.run(end,v,dr,dc)!==5)straight=false;this.state.board[end]=0;}}
   let legal=straight&&!this.exactFive(e,v)&&!this.overline(e,v)&&this.fourCount(e,v)<2;
   if(legal&&depth<4&&this.threeCount(e,v,depth+1)>=2)legal=false;
   this.state.board[e]=0;
   if(legal)groups.add(key);
  }
  return groups.size;
 }
 blackResult(i,v){
  if(this.exactFive(i,v))return {legal:true,win:true};
  if(this.overline(i,v))return {legal:false,win:false,reason:'장목(6목 이상)'};
  if(this.fourCount(i,v)>=2)return {legal:false,win:false,reason:'4-4'};
  if(this.threeCount(i,v)>=2)return {legal:false,win:false,reason:'3-3'};
  return {legal:true,win:false};
 }
 win(i,v){return this.fiveOrMore(i,v);}
 async updateLobby(){try{const code=this.roomCode;if(!this.env?.GAME_ROOM||!code)return;const hub=this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName('__quick_match_v1__'));await hub.fetch(new Request('https://internal/lobby-update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,players:this.state.players.length,status:this.state.status,remove:this.state.players.length===0})}));}catch{}}
 async sendLobby(ws){try{let rooms=await this.ctx.storage.get('rooms')||{};const list=Object.values(rooms).filter(r=>Date.now()-r.at<7200000&&r.players<2);ws.send(JSON.stringify({type:'lobby',online:this.sockets().filter(s=>s.deserializeAttachment()?.kind==='lobby').length,rooms:list}));}catch{}}
 async broadcastLobby(rooms){const list=Object.values(rooms).filter(r=>Date.now()-r.at<7200000&&r.players<2),msg=JSON.stringify({type:'lobby',online:this.sockets().filter(s=>s.deserializeAttachment()?.kind==='lobby').length,rooms:list});for(const s of this.sockets())if(s.deserializeAttachment()?.kind==='lobby')try{s.send(msg)}catch{}}
 async webSocketClose(ws){if(ws.deserializeAttachment()?.kind==='lobby'){ws.serializeAttachment({kind:'lobby',closed:true});const rooms=await this.ctx.storage.get('rooms')||{};this.broadcastLobby(rooms);return;}if(ws.deserializeAttachment()?.kind==='match'){ws.serializeAttachment({kind:'match',queued:false});return;}ws.serializeAttachment({id:null});this.broadcast();}
 async webSocketError(ws){if(ws.deserializeAttachment()?.kind==='match'){ws.serializeAttachment({kind:'match',queued:false});try{ws.close(1011,'연결 오류');}catch{}return;}ws.serializeAttachment({id:null});try{ws.close(1011,'연결 오류');}catch{}this.broadcast();}
 broadcast(){const state={...this.state,players:this.state.players.map(p=>({...p,online:this.online(p.id)}))};const msg=JSON.stringify({type:'state',state});for(const ws of this.sockets())if(ws.deserializeAttachment()?.id)try{ws.send(msg);}catch{}}
}
