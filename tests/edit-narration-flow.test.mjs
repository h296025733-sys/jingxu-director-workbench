import assert from "node:assert/strict";
import test from "node:test";
import { narrationFlowNeedsGrouping, safeNarrationLines, sourceSpeechProfile, assessFullNarrationDelivery, assessNarrationBriefCoverage } from "../lib/edit-narration.ts";

const source = "inputs/01_speaker.mp4";
const analysis = { assets: [{kind:"video",job_path:source,probe:{duration_seconds:27,audio:{codec:"aac"}},silence_spans:[{start:0,end:27}]}] };

test("verified full-track silence is distinguishable from missing ASR words", () => {
  assert.deepEqual(sourceSpeechProfile(analysis, []), {kind:"verified_silence",occupancy:0});
  assert.equal(sourceSpeechProfile({...analysis,assets:[{...analysis.assets[0],silence_spans:[]}]}, []).kind,"unknown");
});

test("one connected performance can span ordinary same-source cuts, but not source speech", () => {
  const plan = {
    clips:[{kind:"video",source,start:0,end:8,speed:1},{kind:"video",source,start:8,end:17,speed:1},{kind:"video",source,start:17,end:27,speed:1}],
    transitions:[],overlays:[],narration:[{start:.2,end:26.4,text:"Need a more lively evening? Put the speaker where the lights can be seen. Use the top controls to change the colors, then start your music from the phone.",evidence:"The speaker, controls, changing lights and phone appear in source video.",x:.5,y:.12,align:8}],
  };
  assert.equal(safeNarrationLines(plan,[],true,{depth:"full",allowAcrossCuts:true,inspectedSources:[source]}).lines.length,1);
  assert.equal(safeNarrationLines(plan,[{source,start:10,end:11}],true,{depth:"full",allowAcrossCuts:true,inspectedSources:[source]}).lines.length,0);
  assert.equal(safeNarrationLines({...plan,narration:[{...plan.narration[0],end:31}]},[],true,{depth:"full",allowAcrossCuts:true,inspectedSources:[source]}).lines.length,0);
});

test("full narration groups even two isolated slots, not intentional brief pauses", () => {
  const lines = [
    {start:.2,end:2.6,text:"Planning a nighttime hangout?",evidence:"speaker"},
    {start:3.9,end:7.9,text:"Place it where the lights stay visible.",evidence:"placement"},
    {start:8.3,end:13.2,text:"The top panel keeps lighting controls within reach.",evidence:"controls"},
    {start:14.7,end:18.5,text:"Three modes add visual variety.",evidence:"LEDs"},
  ];
  assert.equal(narrationFlowNeedsGrouping(lines,"full",true),true);
  assert.equal(narrationFlowNeedsGrouping(lines,"auto",true),true);
  assert.equal(narrationFlowNeedsGrouping(lines,"brief",true),false);
  assert.equal(narrationFlowNeedsGrouping(lines,"full",false),false);
  assert.equal(narrationFlowNeedsGrouping(lines.slice(0,2),"full",true),true);
});

test("spoken delivery gate catches task 292's missing middle and dropped offer", () => {
  const brief="Sometimes music at night needs more than sound. STOREONE has LED lights with three modes. Clear, natural sound adds to the moment. Limited time deal available now.";
  const actual=assessFullNarrationDelivery([
    {start:2,seconds:3.66,text:"After dark, the speaker adds visible LED lighting with three modes."},
    {start:10.9,seconds:5.3,text:"Daylight close-ups clearly show the controls, handle, and two speaker grilles."},
  ],18.3,brief);
  assert.equal(actual.passed,false);
  assert.ok(actual.reasons.includes("口播中段有过长空白"));
  assert.ok(actual.reasons.includes("遗漏用户指定品牌或关键词"));
  assert.ok(actual.reasons.includes("遗漏用户指定优惠收口"));
  assert.ok(actual.reasons.includes("遗漏用户指定音质描述"));
  assert.equal(assessFullNarrationDelivery([{start:.6,seconds:15.4,text:"Some nights need more than music. STOREONE has three LED modes and clear, natural sound. Find your favorite setting and don't miss the limited-time deal."}],18.3,brief).passed,true);
  assert.equal(assessFullNarrationDelivery([{start:.3,seconds:7.2,text:"STOREONE LED tiene tres modos de luz. Aprovecha la oferta."}],9,"STOREONE LED 三种灯光模式，限时优惠。" ).passed,true);
});

test("complete narration shortening cannot delete independent employee points", () => {
  const brief="Running out of battery is a hassle. The STOREONE speaker adds wireless charging. Use it outdoors or with friends. Clear, natural sound improves everyday listening. A limited-time offer is available for multifunctional gear.";
  const truncated="Running out of battery is a hassle. The STOREONE speaker adds wireless charging, so place your phone on top. Use it outdoors or with friends.";
  assert.deepEqual(assessNarrationBriefCoverage(truncated,brief),[
    "遗漏用户指定优惠收口","遗漏用户指定音质描述","遗漏用户指定多功能定位",
  ]);
  const complete="When your phone runs low, extra chargers are a hassle. STOREONE puts wireless charging on the speaker. It works at home, outdoors, or with friends, with clear, natural sound. Like multifunctional gear? Check the limited-time offer.";
  assert.deepEqual(assessNarrationBriefCoverage(complete,brief),[]);
  assert.deepEqual(assessNarrationBriefCoverage(complete.replace("STOREONE","OMU-CA"),brief),[]);
});
