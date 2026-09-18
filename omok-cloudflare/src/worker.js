export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (url.pathname === "/health") return Response.json({ ok: true, name: "Dunbarton Omok Server" }, { headers: cors });
    if (url.pathname.startsWith("/room/")) {
      const code = url.pathname.split("/")[2]?.toUpperCase();
      if (!code || !/^[A-Z0-9]{4,8}$/.test(code)) return new Response("bad room", { status: 400, headers: cors });
      const id = env.GAME_ROOM.idFromName(code);
      return env.GAME_ROOM.get(id).fetch(request);
    }
    return new Response("Dunbarton Omok Online Server", { headers: cors });
  }
};

export class GameRoom {
  constructor(state, env) { this.state = state; this.sessions = new Map(); this.game = null; }
  async load() { if (!this.game) this.game = await this.state.storage.get("game") || { players: [], board: Array(225).fill(0), turn: null, status: "waiting", winner: null, rematch: [] }; }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj) { for (const ws of this.sessions.keys()) this.send(ws, obj); }
  view() { return { type: "state", players: this.game.players, board: this.game.board, turn: this.game.turn, status: this.game.status, winner: this.game.winner }; }
  async save() { await this.state.storage.put("game", this.game); }
  win(b, p, i) { const x=i%15,y=Math.floor(i/15); for(const [dx,dy] of [[1,0],[0,1],[1,1],[1,-1]]){let n=1;for(const s of [-1,1])for(let k=1;k<5;k++){const xx=x+dx*k*s,yy=y+dy*k*s;if(xx<0||xx>14||yy<0||yy>14||b[yy*15+xx]!==p)break;n++;}if(n>=5)return true;}return false; }
  async fetch(req) {
    await this.load();
    if (req.headers.get("Upgrade") !== "websocket") return new Response("WebSocket required", { status: 426 });
    const pair = new WebSocketPair(); const client = pair[0], server = pair[1]; server.accept(); this.sessions.set(server, null);
    server.addEventListener("message", async e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      let sid = this.sessions.get(server);
      if (m.type === "join") {
        sid = String(m.id || "").slice(0,80); const name = String(m.name || "Player").slice(0,12); if(!sid) return;
        this.sessions.set(server, sid);
        let p = this.game.players.find(x => x.id === sid);
        if (!p && this.game.players.length < 2) { const used=this.game.players.map(x=>x.char); let choices=[1,2,3,4].filter(x=>!used.includes(x)); p={id:sid,name,stone:this.game.players.length+1,char:choices[Math.floor(Math.random()*choices.length)]}; this.game.players.push(p); }
        if (this.game.players.length === 2 && this.game.status === "waiting") { this.game.status="playing"; this.game.turn=this.game.players[Math.floor(Math.random()*2)].id; }
        await this.save(); this.broadcast(this.view()); return;
      }
      if (!sid) return;
      if (m.type === "move" && this.game.status === "playing" && this.game.turn === sid) {
        const i=Number(m.i), p=this.game.players.find(x=>x.id===sid); if(!p||!Number.isInteger(i)||i<0||i>=225||this.game.board[i]) return;
        this.game.board[i]=p.stone;
        if(this.win(this.game.board,p.stone,i)){this.game.status="finished";this.game.winner=sid;this.game.turn=null;} else { const other=this.game.players.find(x=>x.id!==sid); if(other)this.game.turn=other.id; }
        await this.save(); this.broadcast(this.view());
      }
      if (m.type === "rematch") {
        if (!this.game.rematch.includes(sid)) this.game.rematch.push(sid);
        if (this.game.players.length===2 && this.game.rematch.length>=2) { this.game.board=Array(225).fill(0);this.game.winner=null;this.game.status="playing";this.game.rematch=[];this.game.turn=this.game.players[Math.floor(Math.random()*2)].id; }
        await this.save(); this.broadcast(this.view());
      }
    });
    server.addEventListener("close", () => this.sessions.delete(server));
    return new Response(null, { status: 101, webSocket: client });
  }
}
