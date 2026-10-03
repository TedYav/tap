import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {queueExplanation} from "../src/queue-explanation";
import {inboxRows} from "../src/slices/inbox-view";
const roots:string[]=[];
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(extra:Record<string,unknown>={}) {
 const home=mkdtempSync(join(tmpdir(),"stale-park-")); roots.push(home);
 mkdirSync(join(home,"spool"));mkdirSync(join(home,"receipts"));
 writeFileSync(join(home,"spool/msg.meta.json"),JSON.stringify({reason:"window",reason_class:"window",next_probe_epoch:100,hold_until_epoch:99,deadline_epoch:300,...extra}));
 return home;
}
test("stale park starts strictly past 30 seconds and survives poll JSON/human rendering",()=>{
 const home=fixture();
 expect(queueExplanation(home,"msg",130)).not.toContain("stale-park");
 const explanation=queueExplanation(home,"msg",131);
 expect(explanation).toContain("stale-park");expect(explanation).toContain("31s overdue");
 expect(explanation).not.toContain("next probe not confirmed");
 const [row]=inboxRows({me:"peer",rows:[{envelope:{id:"msg",from:"sender",kind:"discuss",reply:"expected",path:join(home,"spool/msg.md")},residency:"parked",attributed:true,unconfirmed:false,age:60,queueExplanation:explanation}]});
 expect(row!.item.queue_explanation).toContain("stale-park");expect(row!.human).toContain("stale-park");
});
test("missing and invalid schedules are unknown, not stale",()=>{
 for(const value of [null,"not-a-time",undefined])expect(queueExplanation(fixture({next_probe_epoch:value}),"msg",131)).not.toContain("stale-park");
});
test("terminal unconfirmed and escalated dispositions outrank stale schedules",()=>{
 const home=fixture();writeFileSync(join(home,"receipts/msg.unconfirmed"),"{}");
 expect(queueExplanation(home,"msg",131)).toContain("No further recipient attempt");
 expect(queueExplanation(home,"msg",131)).not.toContain("stale-park");
 expect(queueExplanation(fixture({escalated_at:120}),"msg",131)).not.toContain("stale-park");
});
