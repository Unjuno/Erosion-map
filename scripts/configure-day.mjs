/** Trusted local operator CLI. Not a public HTTP endpoint. */
import { resolve } from "node:path";
import { Store } from "../server/store.mjs";
import { assertIsoDay } from "../dist/calendar.js";

const day=process.env.DAY;
assertIsoDay(day);
const mode=process.env.SAME_GLYPH_MODE ?? "sum";
const minimumOutgoingInfluence=Number(process.env.N1_OUTBOUND ?? 0);
const store=new Store(resolve(process.env.DB_PATH ?? "./.data/erosion.sqlite"));
try {
  store.setDayRules(day,mode,minimumOutgoingInfluence);
  if(process.env.POST_N !== undefined) {
    store.setPostStrength(day,Number(process.env.POST_N));
  }
  console.log(JSON.stringify({day,rules:store.dayRules(day)}));
}finally{store.close();}
