import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { loadPublishedArchive, visitPublishedArchive, ArchiveError } from "../site/archive.js";

const b={minX:-250,maxX:249,minY:-250,maxY:249};
const snapshots=[
  {date:"2026-10-20",bounds:b,cells:[{x:0,y:0,char:"海",n:1}]},
  {date:"2026-10-21",bounds:b,cells:[{x:0,y:0,char:"海",n:1},{x:1,y:0,char:"海",n:1}]},
];
const sha=s=>createHash("sha256").update(s).digest("hex");
const data=snapshots.map(state=>({state,raw:JSON.stringify(state)}));
const index=data.map(item=>({date:item.state.date,sha256:sha(item.raw)}));
const jsonResponse=body=>new Response(body,{status:200,headers:{"content-type":"application/json"}});
const notFound=()=>new Response("missing",{status:404});
const fakeFetch=({tamper=false,api=false,apiHashOnly=false,apiStatus=200,staticMissing=false}={})=>async(url)=>{
  if(url.includes("/api/history") && apiStatus !== 200) return new Response("unavailable", {status:apiStatus});
  if(url.includes("/api/history")) return api?jsonResponse(JSON.stringify({
    days:index.map(x=>({day:x.date,sha256:x.sha256})).reverse(),
  })):notFound();
  if(url.includes("/api/state?date=")){
    const i=index.findIndex(r=>url.includes(r.date));
    return i<0?notFound():jsonResponse(JSON.stringify({
      state:snapshots[i],sha256:(tamper||apiHashOnly)?"0".repeat(64):index[i].sha256,
    }));
  }
  if(url.includes("/data/index.json"))return staticMissing?notFound():jsonResponse(JSON.stringify(index));
  if(url.includes("state-")){
    const i=index.findIndex(r=>url.includes(r.date));
    return i<0?notFound():jsonResponse(tamper?data[i].raw+" ":data[i].raw);
  }
  return notFound();
};

test("verified API snapshots take precedence over static files",async()=>{
  const output=await loadPublishedArchive({
    fetcher:fakeFetch({api:true}),cryptoProvider:webcrypto,limit:2,
  });
  assert.equal(output.source,"api");
  assert.deepEqual(output.states,snapshots);
});

test("static archive loads when API is absent, keeping correct date order",async()=>{
  const output=await loadPublishedArchive({
    fetcher:fakeFetch(),cryptoProvider:webcrypto,limit:2,
  });
  assert.equal(output.source,"static");
  assert.deepEqual(output.states,snapshots);
});

test("altered JSON or mismatched API hash cannot masquerade as published state",async()=>{
  await assert.rejects(loadPublishedArchive({
    fetcher:fakeFetch({tamper:true}),cryptoProvider:webcrypto,limit:2,
  }),/SHA-256|hash|integrity/);
});

test("an insecure origin cannot bypass mandatory WebCrypto verification",async()=>{
  await assert.rejects(loadPublishedArchive({
    fetcher:fakeFetch(),cryptoProvider:{},limit:2,
  }),/verification|Web Crypto|secure/);
});


test("a corrupted API snapshot must not silently fall back to a valid static archive", async () => {
  await assert.rejects(
    () => loadPublishedArchive({
      fetcher:fakeFetch({api:true,apiHashOnly:true}),
      cryptoProvider:webcrypto,limit:2,
    }),
    /hash|integrity|checksum/i,
    "a successful API history response is authoritative, not a hint to load static data"
  );
});

test("an API infrastructure failure must not be disguised as verified static data", async () => {
  await assert.rejects(
    () => loadPublishedArchive({
      fetcher:fakeFetch({apiStatus:503}),cryptoProvider:webcrypto,limit:2,
    }),
    /unavailable|503|service|archive/i
  );
});

test("verified archive visitor streams states in order without retaining all maps", async () => {
  const seen = [];
  const result = await visitPublishedArchive({
    fetcher: fakeFetch({ api: true }), cryptoProvider: webcrypto, limit: 2,
    onSnapshot: (state) => { seen.push(state.date); },
  });
  assert.deepEqual(seen, ["2026-10-20", "2026-10-21"]);
  assert.equal(result.source, "api");
  assert.equal(result.loadedDays, 2);
  assert.deepEqual(result.states, [],
    "streaming ranking consumer must not receive a retained history array");
});

test("absent archives are distinguishable from verified API integrity failures", async () => {
  await assert.rejects(() => loadPublishedArchive({
    fetcher: fakeFetch({ api: false, staticMissing: true }), cryptoProvider: webcrypto,
  }), error => error instanceof ArchiveError && error.kind === "empty");
  await assert.rejects(() => loadPublishedArchive({
    fetcher: fakeFetch({ api: true, apiHashOnly: true }), cryptoProvider: webcrypto,
  }), /hash|integrity/i);
  await assert.rejects(() => visitPublishedArchive({
    fetcher: fakeFetch({ apiStatus: 503 }), cryptoProvider: webcrypto,
    onSnapshot: () => {},
  }), error => error instanceof ArchiveError && error.kind === "transport");
});
