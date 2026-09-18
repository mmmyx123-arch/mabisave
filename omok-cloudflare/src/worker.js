import {HTML} from './page.js';
import {FACE_IMAGES} from './faces.js';
export {GameRoom} from './game.js';
export default {async fetch(request,env){
 const u=new URL(request.url);
 if(request.method!=='GET')return new Response('Method not allowed',{status:405});
 if(FACE_IMAGES[u.pathname])return new Response(Uint8Array.from(atob(FACE_IMAGES[u.pathname]),c=>c.charCodeAt(0)),{headers:{'content-type':'image/jpeg','cache-control':'public,max-age=86400'}});
 if(u.pathname==='/health')return Response.json({ok:true,version:'2.7.0'});
 if(u.pathname==='/match'||u.pathname==='/lobby'){
  const origin=request.headers.get('Origin');if(origin&&origin!==u.origin)return new Response('Forbidden',{status:403});
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName('__quick_match_v1__')).fetch(request);
 }
 if(u.pathname.startsWith('/room/')){
  const code=u.pathname.slice(6).toUpperCase();if(!/^(?:[A-Z0-9]{6}|[A-F0-9]{32})$/.test(code))return new Response('Invalid room',{status:400});
  const origin=request.headers.get('Origin');if(origin&&origin!==u.origin)return new Response('Forbidden',{status:403});
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code)).fetch(request);
 }
 if(u.pathname!=='/')return new Response('Not found',{status:404});
 return new Response(HTML,{headers:{'content-type':'text/html;charset=UTF-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin'}});
}};
