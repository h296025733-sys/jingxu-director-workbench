import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EditingPlanSchemaError,
  assertInFrameRollReportCoverage,
  buildPromptFromRecoveredDirectorPlan,
  buildAutoVideoEditPlanSchema,
  codexCompatibilityFallbackModel,
  normalizeEditingPlanParameters,
  repairCaptionHighlightEffectReasons,
  repairCaptionHighlightProsodyMotion,
  repairMismatchedEditingHighlights,
  repairUnsupportedHighlightMotion,
  recoverEditingPresentation,
  repairEditingCaptionReadability,
  repairEditingDecorativeMarks,
  repairEditingFlashPlacement,
  repairEditingHookPunctuation,
  repairRepeatedAsrSpellingCorrections,
  repairRepeatedEditingMotionTemplates,
  repairUngroundedEditingOverlays,
  resolveEditingSkillBundle,
  resolveEditingLabBoundary,
  validateAutoVideoEditPlan,
  validateEditingModeEvidence,
  validateEditingModePlan,
} from "../lib/codex-director.ts";

test("only an explicit ChatGPT model incompatibility receives one bounded fallback", () => {
  assert.equal(
    codexCompatibilityFallbackModel(
      new Error("The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."),
      "gpt-5.6-sol",
    ),
    "gpt-5.6-terra",
  );
  assert.equal(
    codexCompatibilityFallbackModel(new Error("request timed out"), "gpt-5.6-sol"),
    null,
  );
  assert.equal(
    codexCompatibilityFallbackModel(
      new Error("model is not supported when using Codex with a ChatGPT account"),
      "gpt-5.6-terra",
    ),
    null,
  );
});

test("a ready director draft missing only its prompt is recovered from validated story evidence", () => {
  const input = {
    status: "ready",
    prompts: [],
    understanding: { title: "Test", adaptation: "Keep the real product central" },
    qualityPlan: {
      storyBeats: [
        { timeRange: "0–3秒", visibleEvent: "The light snaps on", promptAnchor: "LIGHT REVEAL", narrativeFunction: "hook", causedBy: "a hand presses the switch", productRole: "shows the flashlight" },
        { timeRange: "3–8秒", visibleEvent: "The speaker fills the tent with sound", promptAnchor: "FULL SOUND", narrativeFunction: "proof", causedBy: "music begins", productRole: "shows the speaker" },
      ],
      mechanismMappings: [],
      replicationLocks: [],
    },
    expressionTimeline: [],
    uploadPlan: [{ reference: "@图片1", coreResponsibility: "锁定真实产品外观", doNotReference: "不参考背景" }],
  };
  const snapshot = structuredClone(input);
  const recovered = buildPromptFromRecoveredDirectorPlan(input, 8);
  assert.equal(recovered.prompts.length, 1);
  assert.match(recovered.prompts[0].content, /0–3秒.*LIGHT REVEAL/su);
  assert.match(recovered.prompts[0].content, /3–8秒.*FULL SOUND/su);
  assert.match(recovered.prompts[0].content, /@图片1.*只负责.*锁定真实产品外观/su);
  assert.deepEqual(input, snapshot, "recovery must not mutate the model draft");
});
import {
  AUTO_EDIT_DEFAULT_BRIEF,
  isAutoEditDefaultBrief,
} from "../lib/auto-edit-defaults.ts";

test("task198 regression: unsupported keyword motion cannot discard the edit", () => {
  for (const [reason, motion, expected] of [
    ["step", "pulse", "none"], ["number", "shake", "none"],
    ["pain", "pulse", "pulse"], ["hook", "shake", "shake"],
    ["proof", "pulse", "pulse"], ["step", "none", "none"],
  ]) {
    const input = {clips: [{source:"inputs/01_demo.mp4", start:0,end:5,mute:false}],
      overlays:[{text:"First wash",effect_reason:reason,start:0,end:2,
        highlights:[{text:"wash",color:"#FFD84D",motion,start:0.5,end:0.8}]}]};
    const snapshot = structuredClone(input);
    const fixed = repairUnsupportedHighlightMotion(input);
    assert.equal(fixed.overlays[0].highlights[0].motion, expected);
    const expectedPlan = structuredClone(input);
    expectedPlan.overlays[0].highlights[0].motion = expected;
    assert.deepEqual(fixed, expectedPlan, "only incompatible motion may change");
    assert.deepEqual(input,snapshot,"never mutate original plan");
    assert.deepEqual(repairUnsupportedHighlightMotion(fixed),fixed,"idempotent");
  }
});

test("task204 regression: an invented highlight cannot discard its grounded caption or edit", () => {
  const input = { clips:[{source:"inputs/01_demo.mp4",start:0,end:5,mute:false}], overlays:[
    {kind:"caption",text:"Y AYUDA A RETIRAR LA ACUMULACIÓN",start:0,end:2,highlights:[{text:"RESULTADO",color:"#68E0C2",motion:"pulse",start:.5,end:.8}]},
    {kind:"caption",text:"Real visible proof",start:2,end:4,highlights:[{text:"visible",color:"#FFD84D",motion:"none",start:null,end:null}]},
  ]};
  const snapshot=structuredClone(input);
  const fixed=repairMismatchedEditingHighlights(input);
  assert.deepEqual(fixed.repairedOverlayIndices,[0]);
  assert.deepEqual(fixed.plan.overlays[0].highlights,[]);
  assert.deepEqual(fixed.plan.overlays[1],input.overlays[1]);
  assert.equal(fixed.plan.overlays[0].text,input.overlays[0].text);
  assert.deepEqual(input,snapshot,"never mutate the model plan");
  assert.deepEqual(repairMismatchedEditingHighlights(fixed.plan).plan,fixed.plan,"idempotent");
});

test("versioned templates override stale caption settings and reject nonexistent production voices", () => {
  assert.equal(normalizeEditingPlanParameters({editColorStyle:"aurora"}).editColorStyle,"aurora");
  assert.equal(normalizeEditingPlanParameters({}).editColorStyle,"original");
  assert.throws(()=>normalizeEditingPlanParameters({editColorStyle:"invalid"}),/配色/);
  const quiet = normalizeEditingPlanParameters({editTemplateId:"clear",captionStyle:"punchy",editTemplateVersion:1});
  assert.equal(quiet.captionStyle,"clean");
  assert.equal(quiet.editTemplateId,"clear");
  const strong = normalizeEditingPlanParameters({editTemplateId:"impact",captionStyle:"clean"});
  assert.equal(strong.captionStyle,"punchy");
  assert.throws(()=>normalizeEditingPlanParameters({editTemplateId:"fake"}),/模板/);
  assert.throws(()=>normalizeEditingPlanParameters({editTemplateId:"focus",editVoice:"female"}),/配音/);
});

test("in-frame roll report distinguishes a missing report from an empty report", () => {
  assert.doesNotThrow(() =>
    assertInFrameRollReportCoverage(null, ["inputs/01_demo.mp4"]),
  );
  assert.throws(
    () => assertInFrameRollReportCoverage([], ["inputs/01_demo.mp4"]),
    /\u7247内方向检测报告没有覆盖全部视频素材/u,
  );
  assert.doesNotThrow(() =>
    assertInFrameRollReportCoverage(
      ["inputs\\01_demo.mp4"],
      ["inputs/01_demo.mp4"],
    ),
  );
  assert.throws(
    () =>
      assertInFrameRollReportCoverage(
        ["inputs/unknown.mp4"],
        ["inputs/01_demo.mp4"],
      ),
    /\u7247内方向检测报告没有覆盖全部视频素材/u,
  );
});

const sources = [
  {
    source: "inputs/01_demo.mp4",
    kind: "video",
    durationSeconds: 30,
    width: 1920,
    height: 1080,
  },
  { source: "inputs/02_product.png", kind: "image" },
  { source: "inputs/03_music.wav", kind: "audio", durationSeconds: 60 },
];

function plan(overrides = {}) {
  return {
    schema_version: 1,
    job_id: "job-1",
    intent_summary: "Open on the demonstrated problem, then show the product and result.",
    output: {
      filename: "job-1.mp4",
      width: 1080,
      height: 1920,
      fps: 30,
      video_codec: "libx264",
      crf: 20,
      preset: "medium",
      audio_bitrate: "192k",
    },
    clips: [
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        start: 2,
        end: 12,
        speed: 1,
        fit: "fill",
        mute: false,
      },
      {
        source: "inputs/02_product.png",
        kind: "image",
        duration: 5,
        fit: "contain",
      },
    ],
    transitions: [],
    overlays: [
      {
        kind: "caption",
        start: 0,
        end: 2,
        text: "看这里",
      },
    ],
    music: null,
    ...overrides,
  };
}

function context(params = {}) {
  return {
    jobId: "job-1",
    sources,
    brief: "开头字幕写：看这里",
    transcriptTexts: ["看这里，然后展示产品。"],
    params: normalizeEditingPlanParameters({
      editMode: "smart",
      editTargetDuration: 15,
      editAspect: "vertical",
      editCaptions: "auto",
      captionStyle: "clean",
      editAudio: "keep",
      transcribe: true,
      ...params,
    }),
  };
}

test("task200 recovers missing captions only from retained audible timed words",()=>{
  const input=plan({overlays:[],clips:[{source:'inputs/01_demo.mp4',kind:'video',start:2,end:8,speed:2,mute:false}]});
  const words=[{source:'inputs/01_demo.mp4',start:2,end:2.5,text:'Wash',probability:.99},{source:'inputs/01_demo.mp4',start:2.5,end:3.5,text:'gently.',probability:.99},
    {source:'inputs/other.mp4',start:2,end:3,text:'wrong',probability:1}];
  const fixed=recoverEditingPresentation(input,context().params,words,[]);
  assert.equal(fixed.overlays[0].text,'Wash gently.');
  assert.equal(fixed.overlays[0].start,0);assert.equal(fixed.overlays[0].end,.75);
  assert.deepEqual(fixed.clips,input.clips);assert.deepEqual(input.overlays,[]);
  const muted=structuredClone(input);muted.clips[0].mute=true;
  assert.deepEqual(recoverEditingPresentation(muted,context().params,words,[]).overlays,[]);
  assert.deepEqual(recoverEditingPresentation(input,context().params,[],[]).overlays,[]);
  assert.deepEqual(recoverEditingPresentation(input,{...context().params,editCaptions:'off'},words,[]).overlays,[]);
  assert.deepEqual(recoverEditingPresentation(fixed,context().params,words,[]),fixed);
  assert.doesNotThrow(()=>validateAutoVideoEditPlan(fixed,{...context({editTargetDuration:0}),brief:'Wash gently.',transcriptTexts:['Wash gently.']}));
});

test("task201 caps existing excess motion without removing words or footage",()=>{
  const input=plan({clips:[{kind:'video',source:'inputs/01_demo.mp4',start:0,end:30,speed:1,mute:false}],overlays:Array.from({length:6},(_,i)=>({kind:'caption',text:'Real proof',start:i*4,end:i*4+2,effect_reason:'proof',highlights:[{text:'proof',motion:'pulse',color:'#FFFFFF',start:i*4,end:i*4+.5}]}))});
  const cues=[{source:'inputs/01_demo.mp4',text:'proof',start:20,end:20.5,level:'high',relativeEnergyDb:8,prePauseSeconds:.2,postPauseSeconds:0}];
  const fixed=recoverEditingPresentation(input,context({captionStyle:'punchy'}).params,[],cues);
  assert.equal(fixed.overlays.filter(o=>o.highlights[0].motion==='pulse').length,3);
  assert.equal(fixed.overlays[5].highlights[0].motion,'pulse');
  assert.deepEqual(fixed.clips,input.clips);assert.deepEqual(fixed.overlays.map(o=>o.text),input.overlays.map(o=>o.text));
  assert.equal(input.overlays.filter(o=>o.highlights[0].motion==='pulse').length,6);
  assert.deepEqual(recoverEditingPresentation(fixed,context({captionStyle:'punchy'}).params,[],cues),fixed);
});

test("task210 regression: a long truthful accent is demoted instead of failing the edit",()=>{
  const input=plan({overlays:[{kind:'label',text:'A complete truthful product explanation belongs in stable readable type',start:1,end:4,preset:'fine_accent',animation:'punch',effect_reason:'proof',highlights:[{text:'product',color:'#68E0C2',motion:'pulse',start:2,end:2.4}]}]});
  const snapshot=structuredClone(input);
  const fixed=recoverEditingPresentation(input,context({captionStyle:'punchy'}).params,[],[]);
  assert.equal(fixed.overlays[0].text,input.overlays[0].text);
  assert.equal(fixed.overlays[0].preset,'default');
  assert.equal(fixed.overlays[0].animation,'fade');
  assert.equal(fixed.overlays[0].effect_reason,'readability');
  assert.deepEqual(fixed.overlays[0].highlights,[]);
  assert.deepEqual(input,snapshot,'never mutate the model plan');
  assert.deepEqual(recoverEditingPresentation(fixed,context({captionStyle:'punchy'}).params,[],[]),fixed,'idempotent');
});

test("task211 regression: unsupported semantic decoration is removed while spoken caption survives",()=>{
  const clips=[{kind:'video',source:'inputs/01_demo.mp4',start:0,end:8,speed:1,mute:false,visual_job:'hook'}];
  const input=plan({clips,overlays:[
    {kind:'label',text:'50%',start:1,end:2,preset:'fine_accent',animation:'pop',effect_reason:'number',highlights:[]},
    {kind:'caption',text:'It saves 50 percent',start:2,end:4,preset:'fine_caption',animation:'fade',effect_reason:'number',highlights:[{text:'50 percent',color:'#68E0C2',motion:'none',start:null,end:null}]},
  ]});
  const fixed=recoverEditingPresentation(input,context({captionStyle:'punchy'}).params,[],[]);
  assert.equal(fixed.overlays.length,1);
  assert.equal(fixed.overlays[0].kind,'caption');
  assert.equal(fixed.overlays[0].text,'It saves 50 percent');
  assert.equal(fixed.overlays[0].effect_reason,'readability');
  assert.deepEqual(fixed.overlays[0].highlights,[]);
  assert.equal(input.overlays[0].text,'50%','never mutate the model plan');
});

test("editing modes select one dedicated skill while old tasks keep safe defaults", () => {
  assert.deepEqual(normalizeEditingPlanParameters({}), {
    watermarkOnly: false,
    editColorStyle: "original",
    editNarrationDepth: "auto",
    editMode: "smart",
    editTargetDuration: 0,
    editAspect: "auto",
    editCaptions: "auto",
    captionStyle: "punchy",
    editAudio: "keep",
    transcribe: false,
    subtitleLanguage: "en",
  });
  const expected = {
    smart: "auto-edit-smart",
    talking_head: "auto-edit-talking-head",
    digital_presenter: "auto-edit-digital-presenter",
    product_demo: "auto-edit-product-demo",
  };
  for (const [mode, skill] of Object.entries(expected)) {
    const bundle = resolveEditingSkillBundle(mode);
    assert.equal(bundle.length, 2);
    assert.equal(bundle[0].skill, "auto-video-editor");
    assert.equal(bundle[1].skill, skill);
    assert.equal(bundle[0].files.includes("references/effect-decisions.md"), true);
    assert.deepEqual(bundle[1].files, ["SKILL.md"]);
  }
  assert.throws(
    () => normalizeEditingPlanParameters({ editMode: "voice_clone" }),
    /editMode/u,
  );
  assert.throws(
    () => normalizeEditingPlanParameters({ captionStyle: "random" }),
    /captionStyle/u,
  );
  assert.throws(
    () => normalizeEditingPlanParameters({ subtitleLanguage: "fr" }),
    /subtitleLanguage/u,
  );
});

test("talking-head modes require real transcript evidence with an actionable fallback", () => {
  const talking = normalizeEditingPlanParameters({
    editMode: "talking_head",
    transcribe: true,
  });
  assert.throws(
    () => validateEditingModeEvidence(talking, []),
    /智能精剪\/产品展示/u,
  );
  assert.doesNotThrow(() => validateEditingModeEvidence(talking, ["这是实际口播"]));
  const disabled = normalizeEditingPlanParameters({
    editMode: "digital_presenter",
    transcribe: false,
  });
  assert.throws(() => validateEditingModeEvidence(disabled, ["有文字"]), /开启/u);
});

test("caption styles keep body captions readable and limit clean-mode decoration", () => {
  const cleanParams = context({ captionStyle: "clean" }).params;
  assert.doesNotThrow(
    () => validateEditingModePlan(plan({ overlays: [] }), cleanParams, ["看这里"]),
  );
  assert.doesNotThrow(() =>
    validateEditingModePlan(plan({ overlays: [] }), cleanParams, []),
  );
  const excessiveClean = plan({
    overlays: [0, 1, 2].map((index) => ({
      kind: "title",
      start: index,
      end: index + 0.8,
      text: "看这里",
      preset: "hook",
      animation: "pop",
    })),
  });
  assert.throws(
    () => validateEditingModePlan(excessiveClean, cleanParams, ["看这里"]),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("规整易读")),
  );
  const animatedPlainCleanTitle = plan({
    overlays: [{
      kind: "title",
      start: 0,
      end: 1,
      text: "看这里",
      preset: "default",
      animation: "bounce",
    }],
  });
  assert.throws(
    () => validateEditingModePlan(animatedPlainCleanTitle, cleanParams, []),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("规整易读")),
  );

  const punchyParams = context({ captionStyle: "punchy" }).params;
  const punchyWithoutEmphasis = plan({
    overlays: [{
      kind: "caption",
      start: 0,
      end: 2,
      text: "看这里",
      preset: "default",
      animation: "fade",
    }],
  });
  assert.throws(
    () => validateEditingModePlan(
      punchyWithoutEmphasis,
      punchyParams,
      ["看这里"],
    ),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("至少使用一处")),
  );
  const unreadableSpeech = plan({
    overlays: [{
      kind: "caption",
      start: 0,
      end: 2,
      text: "看这里",
      preset: "hook",
      animation: "pop",
    }],
  });
  assert.throws(
    () => validateEditingModePlan(unreadableSpeech, punchyParams, ["看这里"]),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("口播字幕")),
  );
  const supportedPunchy = plan({
    overlays: [
      { kind: "title", start: 0, end: 1, text: "看这里", preset: "hook", animation: "pop" },
      { kind: "caption", start: 1, end: 2, text: "看这里", preset: "default", animation: "fade" },
    ],
  });
  assert.equal(
    validateEditingModePlan(supportedPunchy, punchyParams, ["看这里"]).overlays.length,
    2,
  );
  const phraseHighlightPunchy = plan({
    overlays: [{
      kind: "caption",
      start: 0,
      end: 2,
      text: "看这里，然后展示产品",
      highlights: [{ text: "展示产品", color: "#68E0C2" }],
      preset: "default",
      animation: "fade",
    }],
  });
  assert.equal(
    validateEditingModePlan(
      phraseHighlightPunchy,
      punchyParams,
      ["看这里，然后展示产品"],
    ).overlays.length,
    1,
  );
  const titleOnlyWithoutEmphasis = plan({
    overlays: [{
      kind: "title",
      start: 0,
      end: 1,
      text: "看这里",
      preset: "default",
      animation: "fade",
    }],
  });
  assert.throws(
    () => validateEditingModePlan(titleOnlyWithoutEmphasis, punchyParams, []),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("至少使用一处")),
  );
  const titleOnlyPunchy = plan({
    overlays: [{
      kind: "title",
      start: 0,
      end: 1,
      text: "看这里",
      preset: "hook",
      animation: "punch",
    }],
  });
  assert.equal(
    validateEditingModePlan(titleOnlyPunchy, punchyParams, []).overlays.length,
    1,
  );
});

test("punchy hybrid edits require real size hierarchy and bounded visual punctuation", () => {
  const clip = (visualJob, start, end) => ({
    source: "inputs/01_demo.mp4",
    kind: "video",
    visual_job: visualJob,
    selection_reason: `The ${visualJob} phrase and matching action are visible in this exact range.`,
    exit_condition: `The ${visualJob} phrase and action complete before the cut.`,
    start,
    end,
    duration: 0,
    speed: 1,
    fit: "fill",
    audio_gain_db: 0,
    mute: false,
    motion: null,
  });
  const captionsOnly = plan({
    narrative_regime: "hybrid",
    clips: [
      clip("hook", 0, 3),
      clip("problem", 3, 6),
      clip("feature", 6, 8),
      clip("action", 8, 10),
      clip("payoff", 10, 15),
    ],
    overlays: [
      {
        kind: "caption",
        start: 0,
        end: 3,
        text: "Can we talk about body bumps?",
        highlights: [{ text: "body bumps", color: "#FF5A5F" }],
        preset: "default",
        animation: "fade",
        effect_reason: "hook",
      },
      {
        kind: "caption",
        start: 6,
        end: 8,
        text: "This is a 2% body wash.",
        highlights: [{ text: "2%", color: "#FFD166" }],
        preset: "default",
        animation: "fade",
        effect_reason: "number",
      },
      {
        kind: "caption",
        start: 10,
        end: 12,
        text: "Now I can wear the dress.",
        highlights: [{ text: "wear the dress", color: "#FFD166" }],
        preset: "default",
        animation: "fade",
        effect_reason: "payoff",
      },
    ],
  });
  const params = context({
    editTargetDuration: 0,
    captionStyle: "punchy",
  }).params;
  const transcript = [
    "Can we talk about body bumps? This is a 2% body wash. Now I can wear the dress.",
  ];
  assert.throws(
    () => validateEditingModePlan(captionsOnly, params, transcript),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("同字号字幕")),
  );

  const enriched = structuredClone(captionsOnly);
  enriched.overlays = enriched.overlays.filter(
    (overlay) => !(overlay.kind === "caption" && overlay.start === 6),
  );
  enriched.overlays.push(
    {
      kind: "title",
      start: 0,
      end: 1.1,
      text: "body bumps",
      highlights: [],
      preset: "fine_hook",
      animation: "punch",
      effect_reason: "hook",
      color: "#FFFFFF",
      outline_color: "#101010",
      x: 0.26,
      y: 0.16,
      align: 5,
      layer: 12,
    },
    {
      kind: "label",
      start: 3.2,
      end: 4,
      text: "☹",
      highlights: [],
      preset: "fine_reaction",
      animation: "bounce",
      effect_reason: "pain",
      color: "#FF5A5F",
      outline_color: "#101010",
      x: 0.18,
      y: 0.2,
      align: 5,
      layer: 12,
    },
    {
      kind: "label",
      start: 6,
      end: 7.1,
      text: "2%",
      highlights: [],
      preset: "fine_accent",
      animation: "pop",
      effect_reason: "number",
      color: "#FFD84D",
      outline_color: "#101010",
      x: 0.25,
      y: 0.24,
      align: 5,
      layer: 12,
    },
    {
      kind: "label",
      start: 8.1,
      end: 9.2,
      text: "body wash",
      highlights: [],
      preset: "fine_accent",
      animation: "slide_left",
      effect_reason: "proof",
      color: "#68E0C2",
      outline_color: "#101010",
      x: 0.24,
      y: 0.25,
      align: 5,
      layer: 12,
    },
    {
      kind: "label",
      start: 10.2,
      end: 11,
      text: ":)",
      highlights: [],
      preset: "fine_reaction",
      animation: "tag",
      effect_reason: "payoff",
      color: "#101010",
      outline_color: "#C1E655",
      x: 0.78,
      y: 0.22,
      align: 5,
      layer: 12,
    },
    {
      kind: "label",
      start: 12.2,
      end: 13.4,
      text: "wear the dress",
      highlights: [],
      preset: "fine_accent",
      animation: "slide_up",
      effect_reason: "payoff",
      color: "#FFD84D",
      outline_color: "#101010",
      x: 0.5,
      y: 0.24,
      align: 5,
      layer: 12,
    },
  );
  enriched.finishing = {
    preset: "none",
    flashes: [{ start: 10.05, duration: 0.06, color: "white", alpha: 0.16 }],
  };
  assert.doesNotThrow(() => validateEditingModePlan(enriched, params, transcript));
  assert.doesNotThrow(() =>
    validateAutoVideoEditPlan(enriched, {
      ...context({ editTargetDuration: 0, captionStyle: "punchy" }),
      brief: AUTO_EDIT_DEFAULT_BRIEF,
      transcriptTexts: transcript,
    }),
  );

  const withoutTemplateStickers = structuredClone(enriched);
  withoutTemplateStickers.overlays = withoutTemplateStickers.overlays.filter(
    (overlay) => overlay.text !== "☹" && overlay.text !== ":)",
  );
  assert.doesNotThrow(() =>
    validateEditingModePlan(withoutTemplateStickers, params, transcript),
    "reaction stickers are optional and must not be forced into every problem/payoff story",
  );

  const overlongHook = structuredClone(enriched);
  overlongHook.overlays.find((overlay) => overlay.preset === "fine_hook").text =
    "Can we talk about body bumps that change your whole outfit?";
  assert.throws(
    () => validateEditingModePlan(overlongHook, params, transcript),
    /大号文字过长/u,
  );

  const overlongEditorialAccent = structuredClone(enriched);
  overlongEditorialAccent.overlays.find(
    (overlay) => overlay.preset === "fine_accent" && overlay.text === "body wash",
  ).text = "This is a 2% body wash.";
  assert.throws(
    () => validateEditingModePlan(overlongEditorialAccent, params, transcript),
    /艺术强调过长/u,
  );

  const overlongMediumCard = structuredClone(enriched);
  const mediumCard = overlongMediumCard.overlays.find(
    (overlay) => overlay.preset === "fine_accent" && overlay.text === "body wash",
  );
  mediumCard.preset = "badge";
  mediumCard.text = "to help unclog pores and exfoliate the build up";
  assert.throws(
    () => validateEditingModePlan(overlongMediumCard, params, transcript),
    /中号信息卡过长/u,
  );

  const supportedEmoji = structuredClone(enriched);
  const painSticker = supportedEmoji.overlays.find((overlay) => overlay.text === "☹");
  painSticker.text = "🙈";
  assert.doesNotThrow(() =>
    validateAutoVideoEditPlan(supportedEmoji, {
      ...context({ editTargetDuration: 0, captionStyle: "punchy" }),
      brief: AUTO_EDIT_DEFAULT_BRIEF,
      transcriptTexts: transcript,
    }),
  );

  const unsupportedEmoji = structuredClone(enriched);
  unsupportedEmoji.overlays.at(-1).text = "🔥";
  assert.throws(
    () =>
      validateAutoVideoEditPlan(unsupportedEmoji, {
        ...context({ editTargetDuration: 0, captionStyle: "punchy" }),
        brief: AUTO_EDIT_DEFAULT_BRIEF,
        transcriptTexts: transcript,
      }),
    /允许的非语言标点/u,
  );
});

test("an unsupported flash is dropped, never relocated to fill an effects quota", () => {
  const clip = (visualJob, start, end, motion = null) => ({
    source: "inputs/01_demo.mp4",
    kind: "video",
    visual_job: visualJob,
    selection_reason: `The ${visualJob} evidence is visible in this exact range.`,
    exit_condition: `The ${visualJob} event completes before the cut.`,
    start,
    end,
    duration: 0,
    speed: 1,
    fit: "fill",
    audio_gain_db: 0,
    mute: false,
    motion,
  });
  const misplaced = plan({
    narrative_regime: "product_proof",
    clips: [clip("feature", 0, 2), clip("payoff", 2, 4)],
    overlays: [],
    finishing: {
      preset: "none",
      flashes: [{ start: 0.5, duration: 0.06, color: "white", alpha: 0.15 }],
    },
  });
  const relocated = repairEditingFlashPlacement(misplaced);
  assert.equal(relocated.movedCount, 0);
  assert.equal(relocated.removedCount, 1);
  assert.deepEqual(relocated.plan.finishing.flashes, []);
  assert.doesNotThrow(() =>
    validateEditingModePlan(
      relocated.plan,
      context({ captionStyle: "clean", editCaptions: "off" }).params,
      [],
    ),
  );

  const alreadyAnimated = structuredClone(misplaced);
  alreadyAnimated.clips[1].motion = {
    zoom_start: 1,
    zoom_end: 1.05,
    focus_x_start: 0.5,
    focus_x_end: 0.5,
    focus_y_start: 0.5,
    focus_y_end: 0.5,
  };
  const removed = repairEditingFlashPlacement(alreadyAnimated);
  assert.equal(removed.movedCount, 0);
  assert.equal(removed.removedCount, 1);
  assert.deepEqual(removed.plan.finishing.flashes, []);
});

test("a reaction sticker with the wrong glyph is repaired instead of failing the cut", () => {
  const mismatched = plan({
    narrative_regime: "product_proof",
    clips: [
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        visual_job: "problem",
        selection_reason: "The visible concern establishes the problem.",
        exit_condition: "The concern is readable before the cut.",
        start: 0,
        end: 2,
        duration: 0,
        speed: 1,
        fit: "fill",
        audio_gain_db: 0,
        mute: false,
        motion: null,
      },
    ],
    overlays: [
      {
        kind: "caption",
        start: 0.6,
        end: 1.3,
        text: "☺",
        highlights: [],
        preset: "fine_reaction",
        animation: "pop",
        effect_reason: "pain",
        color: "#FFFFFF",
        outline_color: "#111111",
        x: 0.82,
        y: 0.24,
        align: "center",
        layer: 4,
      },
    ],
  });
  const repaired = repairEditingDecorativeMarks(mismatched);
  assert.deepEqual(repaired.repairedOverlayIndices, [0]);
  assert.equal(repaired.plan.overlays[0].text, "☹");
  assert.equal(repaired.plan.overlays[0].effect_reason, "pain");
  assert.equal(repaired.plan.overlays[0].preset, "fine_reaction");
});

test("previous hidden one-click briefs stay internal after the default evolves", () => {
  const previous =
    "自动精剪：以视频1为主线，保留原意、人物与产品身份以及完整动作；删除明确停顿、口误、重复、无信息黑场和无效等待。根据真实画面与转录自动判断叙事类型，先用最强的可见或可听信息形成开场钩子，再推进主体并自然收尾。字幕逐字忠于原声，只在钩子、关键数字、痛点、证明或行动点做少量内容驱动强调。若有视频2，仅在与当前语句或动作直接相关时短切或静音画中画；画中画存在安全留白且确能引导注意时可加醒目箭头，不遮脸、嘴、产品、手部或字幕。不得创造素材中不存在的产品效果、卖点、台词、音乐、音效或动作。";
  assert.equal(isAutoEditDefaultBrief(previous), true);
  assert.equal(isAutoEditDefaultBrief(AUTO_EDIT_DEFAULT_BRIEF), true);
  assert.equal(isAutoEditDefaultBrief("请把第二句话剪掉"), false);
});

test("structured editing schema exposes only animations and presets implemented by AutoLab", () => {
  const schema = buildAutoVideoEditPlanSchema({
    visualSources: ["inputs/01_demo.mp4"],
    audioSources: [],
  });
  const overlay = schema.properties.overlays.items.properties;
  assert.equal(overlay.preset.enum.includes("fine_micro"), true);
  assert.equal(overlay.preset.enum.includes("fine_reaction"), true);
  assert.equal(overlay.preset.enum.includes("fine_step_number"), true);
  assert.equal(overlay.preset.enum.includes("fine_step_action"), true);
  assert.equal(overlay.highlights.maxItems, 1);
  const highlight = overlay.highlights.items;
  assert.deepEqual(highlight.required, ["text", "color", "motion", "start", "end"]);
  assert.deepEqual(highlight.properties.motion.enum, ["none", "pulse", "shake"]);
  assert.equal(overlay.effect_reason.enum.includes("readability"), true);
  assert.equal(overlay.effect_reason.enum.includes("payoff"), true);
  assert.deepEqual(overlay.animation.enum, [
    "none",
    "fade",
    "pop",
    "punch",
    "bounce",
    "slide_left",
    "slide_right",
    "slide_up",
    "drop",
    "tag",
    "cta_hold",
  ]);
  assert.equal(overlay.x.maximum, 1);
  assert.equal(overlay.y.maximum, 1);
  assert.deepEqual(schema.properties.transitions.items.properties.type.enum, [
    "dissolve",
    "dip_to_black",
    "slide_left",
    "slide_right",
  ]);
});

test("low-confidence ASR spelling may be corrected without opening a paraphrase path", () => {
  const transcriptTexts = [
    "So I switched to this 2% salicynic acid body wash.",
    "This loother has salicynic acid to help unclog pores.",
  ];
  const transcriptWords = [
    {
      source: "inputs/01_demo.mp4",
      start: 6.5,
      end: 6.9,
      text: "salicynic",
      probability: 0.667,
    },
    {
      source: "inputs/01_demo.mp4",
      start: 10.52,
      end: 10.88,
      text: "loother",
      probability: 0.51,
    },
  ];
  const grounded = {
    ...context({ editTargetDuration: 0 }),
    brief: AUTO_EDIT_DEFAULT_BRIEF,
    transcriptTexts,
    transcriptWords,
  };
  const corrected = plan({
    overlays: [
      {
        kind: "label",
        start: 0,
        end: 1.5,
        text: "2% salicylic acid body wash.",
      },
      {
        kind: "caption",
        start: 1.5,
        end: 3.5,
        text: "This lather has salicylic acid",
      },
    ],
  });
  assert.doesNotThrow(() => validateAutoVideoEditPlan(corrected, grounded));

  const paraphrase = structuredClone(corrected);
  paraphrase.overlays[1].text = "This cleanser has salicylic acid";
  assert.throws(
    () => validateAutoVideoEditPlan(paraphrase, grounded),
    /不是转录\/brief 原文/u,
  );

  const confidentContext = {
    ...grounded,
    transcriptWords: transcriptWords.map((word) => ({ ...word, probability: 0.99 })),
  };
  assert.throws(
    () => validateAutoVideoEditPlan(corrected, confidentContext),
    /不是转录\/brief 原文/u,
  );
});

test("an accepted ASR spelling correction stays consistent across later captions", () => {
  const transcriptTexts = [
    "So I switched to this 2% salicynic acid body wash.",
    "This loother has salicynic acid to help unclog pores.",
  ];
  const transcriptWords = [
    {
      source: "inputs/01_demo.mp4",
      start: 6.5,
      end: 6.9,
      text: "salicynic",
      probability: 0.667,
    },
    {
      source: "inputs/01_demo.mp4",
      start: 10.52,
      end: 10.88,
      text: "loother",
      probability: 0.51,
    },
  ];
  const input = plan({
    overlays: [
      {
        kind: "caption",
        start: 0,
        end: 1.5,
        text: "2% salicylic acid body wash.",
        highlights: [{
          text: "salicylic acid",
          color: "#FFD166",
          motion: "none",
          start: 0.5,
          end: 1.1,
        }],
        preset: "fine_caption",
        animation: "fade",
        effect_reason: "proof",
      },
      {
        kind: "caption",
        start: 1.5,
        end: 3.5,
        text: "This lather has salicynic acid",
        highlights: [{
          text: "salicynic acid",
          color: "#68E0C2",
          motion: "none",
          start: 2.4,
          end: 3.1,
        }],
        preset: "fine_caption",
        animation: "fade",
        effect_reason: "proof",
      },
    ],
  });

  const repaired = repairRepeatedAsrSpellingCorrections(
    input,
    transcriptTexts,
    transcriptWords,
  );
  assert.deepEqual(repaired.repairedOverlayIndices, [1]);
  assert.equal(repaired.plan.overlays[1].text, "This lather has salicylic acid");
  assert.equal(repaired.plan.overlays[1].highlights[0].text, "salicylic acid");
  assert.equal(input.overlays[1].text, "This lather has salicynic acid");
  assert.doesNotThrow(() => validateAutoVideoEditPlan(repaired.plan, {
    ...context({ editTargetDuration: 0 }),
    brief: AUTO_EDIT_DEFAULT_BRIEF,
    transcriptTexts,
    transcriptWords,
  }));
});

test("unambiguous low-confidence product terms are repaired before render", () => {
  const transcriptTexts = [
    "So I switched to this 2% salicynic acid body wash.",
    "This loother has salicynic acid to help unclog pores.",
  ];
  const transcriptWords = [
    {
      source: "inputs/01_demo.mp4",
      start: 6.5,
      end: 6.9,
      text: "salicynic",
      probability: 0.667,
    },
    {
      source: "inputs/01_demo.mp4",
      start: 10.52,
      end: 10.88,
      text: "loother",
      probability: 0.51,
    },
  ];
  const input = plan({
    overlays: [
      {
        kind: "label",
        start: 0,
        end: 1.5,
        text: "2% salicynic acid body wash.",
        highlights: [],
        preset: "feature",
        animation: "tag",
        effect_reason: "number",
      },
      {
        kind: "caption",
        start: 1.5,
        end: 3.5,
        text: "This loother has salicynic acid",
        highlights: [{
          text: "salicynic acid",
          color: "#68E0C2",
          motion: "none",
          start: 2.4,
          end: 3.1,
        }],
        preset: "fine_caption",
        animation: "fade",
        effect_reason: "proof",
      },
    ],
  });
  const snapshot = structuredClone(input);
  const repaired = repairRepeatedAsrSpellingCorrections(
    input,
    transcriptTexts,
    transcriptWords,
  );
  assert.deepEqual(repaired.repairedOverlayIndices, [0, 1]);
  assert.equal(repaired.plan.overlays[0].text, "2% salicylic acid body wash.");
  assert.equal(repaired.plan.overlays[1].text, "This lather has salicylic acid");
  assert.equal(repaired.plan.overlays[1].highlights[0].text, "salicylic acid");
  assert.deepEqual(input, snapshot, "spelling repair must preserve the model draft");
  assert.doesNotThrow(() => validateAutoVideoEditPlan(repaired.plan, {
    ...context({ editTargetDuration: 0 }),
    brief: AUTO_EDIT_DEFAULT_BRIEF,
    transcriptTexts,
    transcriptWords,
  }));
});

test("ASR spelling repair remains grounded across adjacent transcript segments", () => {
  const transcriptTexts = [
    "This loother has",
    "salicynic acid for the body",
  ];
  const transcriptWords = [
    { source: "inputs/01_demo.mp4", start: 0, end: 0.2, text: "This", probability: 0.99 },
    { source: "inputs/01_demo.mp4", start: 0.2, end: 0.6, text: "loother", probability: 0.51 },
    { source: "inputs/01_demo.mp4", start: 0.6, end: 0.8, text: "has", probability: 0.98 },
    { source: "inputs/01_demo.mp4", start: 0.8, end: 1.2, text: "salicynic", probability: 0.66 },
    { source: "inputs/01_demo.mp4", start: 1.2, end: 1.4, text: "acid", probability: 0.99 },
    { source: "inputs/01_demo.mp4", start: 1.4, end: 1.6, text: "for", probability: 0.99 },
    { source: "inputs/01_demo.mp4", start: 1.6, end: 1.8, text: "the", probability: 0.99 },
    { source: "inputs/01_demo.mp4", start: 1.8, end: 2.1, text: "body", probability: 0.99 },
  ];
  const input = plan({
    overlays: [{
      kind: "caption",
      start: 0,
      end: 2.1,
      text: "This loother has salicynic acid for the body",
      highlights: [],
      preset: "fine_caption",
      animation: "fade",
      effect_reason: "readability",
    }],
  });
  const repaired = repairRepeatedAsrSpellingCorrections(
    input,
    transcriptTexts,
    transcriptWords,
  );
  assert.equal(
    repaired.plan.overlays[0].text,
    "This lather has salicylic acid for the body",
  );
  assert.doesNotThrow(() => validateAutoVideoEditPlan(repaired.plan, {
    ...context({ editTargetDuration: 0 }),
    brief: AUTO_EDIT_DEFAULT_BRIEF,
    transcriptTexts,
    transcriptWords,
  }));
});

test("a short opening hook inherits only the real transcript question mark", () => {
  const input = plan({
    overlays: [{
      kind: "title",
      start: 0,
      end: 1.3,
      text: "body bumps",
      highlights: [{
        text: "body",
        color: "#FF6B6B",
        motion: "shake",
        start: 0.92,
        end: 1.12,
      }],
      preset: "fine_hook",
      animation: "punch",
      effect_reason: "pain",
    }],
  });
  const repaired = repairEditingHookPunctuation(
    input,
    ["Body bumps that change your whole outfit?"],
  );
  assert.deepEqual(repaired.repairedOverlayIndices, [0]);
  assert.equal(repaired.plan.overlays[0].text, "body bumps?");
  assert.equal(repaired.plan.overlays[0].highlights[0].text, "body");
  assert.doesNotThrow(() => validateAutoVideoEditPlan(repaired.plan, {
    ...context({ editTargetDuration: 0 }),
    brief: AUTO_EDIT_DEFAULT_BRIEF,
    transcriptTexts: ["Body bumps that change your whole outfit?"],
  }));

  const statement = repairEditingHookPunctuation(
    input,
    ["Body bumps can change your outfit."],
  );
  assert.equal(statement.plan.overlays[0].text, "body bumps");
});

test("unsupported model-written display copy is removed without sacrificing grounded text", () => {
  const candidate = plan({
    overlays: [
      {
        kind: "caption",
        start: 0,
        end: 1,
        text: "These body bumps changed everything",
        highlights: [],
      },
      {
        kind: "label",
        start: 1,
        end: 1.8,
        text: "SKIN RESET",
        highlights: [],
      },
      {
        kind: "label",
        start: 1.8,
        end: 2.2,
        text: "?!",
        highlights: [],
      },
      {
        kind: "caption",
        start: 2.2,
        end: 3.2,
        text: "A better routine starts now",
        highlights: [],
      },
    ],
  });
  const evidence = {
    brief: AUTO_EDIT_DEFAULT_BRIEF,
    transcriptTexts: ["These body bumps changed everything"],
    transcriptWords: [],
  };
  const firstPass = repairUngroundedEditingOverlays(candidate, evidence);
  assert.deepEqual(firstPass.removedOverlayIndices, [1]);
  assert.deepEqual(firstPass.plan.overlays.map((overlay) => overlay.text), [
    "These body bumps changed everything",
    "?!",
    "A better routine starts now",
  ]);

  const finalPass = repairUngroundedEditingOverlays(candidate, evidence, {
    dropCaptions: true,
  });
  assert.deepEqual(finalPass.removedOverlayIndices, [1, 3]);
  assert.deepEqual(finalPass.plan.overlays.map((overlay) => overlay.text), [
    "These body bumps changed everything",
    "?!",
  ]);
  assert.equal(candidate.overlays.length, 4, "repair must preserve the model draft");
});

test("spoken-word motion is timed inside its caption and remains semantically sparse", () => {
  const params = context({ captionStyle: "punchy" }).params;
  const valid = plan({
    narrative_regime: "general",
    clips: [{
      source: "inputs/01_demo.mp4",
      kind: "video",
      visual_job: "feature",
      selection_reason: "The speaker stresses the stated concentration.",
      exit_condition: "The concentration phrase ends.",
      start: 2,
      end: 12,
      speed: 1,
      fit: "fill",
      mute: false,
    }],
    overlays: [{
      kind: "caption",
      start: 0,
      end: 2,
      text: "I use this 2% body wash",
      highlights: [{
        text: "2%",
        color: "#68E0C2",
        motion: "pulse",
        start: 0.72,
        end: 0.98,
      }],
      preset: "fine_caption",
      animation: "fade",
      effect_reason: "number",
    }],
  });
  const grounded = {
    ...context({ captionStyle: "punchy", editTargetDuration: 0 }),
    brief: "I use this 2% body wash",
    transcriptTexts: ["I use this 2% body wash"],
  };
  assert.doesNotThrow(() => validateAutoVideoEditPlan(valid, grounded));
  const prosodyCues = [{
    source: "inputs/01_demo.mp4",
    start: 2.72,
    end: 2.98,
    text: "2%",
    relativeEnergyDb: 4.1,
    prePauseSeconds: 0.08,
    postPauseSeconds: 0.04,
    level: "high",
  }];
  assert.doesNotThrow(() =>
    validateEditingModePlan(valid, params, grounded.transcriptTexts, prosodyCues),
  );

  const outsideCaption = structuredClone(valid);
  outsideCaption.overlays[0].highlights[0].end = 2.4;
  assert.throws(
    () => validateAutoVideoEditPlan(outsideCaption, grounded),
    /所属画面文字/u,
  );

  const decorativeShake = structuredClone(valid);
  decorativeShake.overlays[0].highlights[0].motion = "shake";
  decorativeShake.overlays[0].effect_reason = "number";
  assert.throws(
    () => validateEditingModePlan(decorativeShake, params, grounded.transcriptTexts),
    /震动只能用于真实钩子、痛点或反差/u,
  );
  const staticNumber = repairUnsupportedHighlightMotion(decorativeShake);
  assert.doesNotThrow(() => validateAutoVideoEditPlan(staticNumber, grounded));
  assert.doesNotThrow(() => validateEditingModePlan(staticNumber, params, grounded.transcriptTexts));

  const invalidStep = structuredClone(valid);
  invalidStep.clips[0].visual_job = "action";
  invalidStep.overlays[0].effect_reason = "step";
  invalidStep.overlays[0].text = "First wash your hands";
  invalidStep.overlays[0].highlights[0].text = "wash";
  const stepContext = {...grounded, brief:"First wash your hands", transcriptTexts:["First wash your hands"]};
  assert.throws(() => validateEditingModePlan(invalidStep,params,stepContext.transcriptTexts),/重点词放大/);
  const staticStep = repairUnsupportedHighlightMotion(invalidStep);
  assert.doesNotThrow(() => validateAutoVideoEditPlan(staticStep,stepContext));
  assert.doesNotThrow(() => validateEditingModePlan(staticStep,params,stepContext.transcriptTexts));
});

test("a real stressed semantic keyword is upgraded once instead of staying color-only", () => {
  const params = context({ captionStyle: "punchy" }).params;
  const colorOnly = plan({
    narrative_regime: "general",
    clips: [{
      source: "inputs/01_demo.mp4",
      kind: "video",
      visual_job: "problem",
      selection_reason: "The speaker names the problem.",
      exit_condition: "The pain statement ends.",
      start: 2,
      end: 8,
      speed: 1,
      fit: "fill",
      mute: false,
    }],
    overlays: [{
      kind: "caption",
      start: 0,
      end: 2,
      text: "I still hide my shoulders",
      highlights: [{
        text: "hide",
        color: "#FF6B6B",
        motion: "none",
        start: 0.7,
        end: 0.88,
      }],
      preset: "fine_caption",
      animation: "none",
      effect_reason: "pain",
    }],
  });
  const snapshot = structuredClone(colorOnly);
  const repaired = repairCaptionHighlightProsodyMotion(colorOnly, params, [{
    source: "inputs/01_demo.mp4",
    start: 2.7,
    end: 2.88,
    text: "hide",
    relativeEnergyDb: 3.2,
    prePauseSeconds: 0,
    postPauseSeconds: 0.08,
    level: "medium",
  }]);

  assert.deepEqual(repaired.repairedOverlayIndices, [0]);
  assert.equal(repaired.plan.overlays[0].highlights[0].motion, "pulse");
  assert.equal(repaired.plan.overlays[0].highlights[0].start, 0.7);
  assert.equal(repaired.plan.overlays[0].highlights[0].end, 0.88);
  assert.deepEqual(colorOnly, snapshot, "prosody repair must not mutate the model draft");
  assert.equal(
    repairCaptionHighlightProsodyMotion(
      colorOnly,
      context({ captionStyle: "clean" }).params,
      [],
    ).plan,
    colorOnly,
  );
});

test("a high spoken pain word can become one bounded shake without invented copy", () => {
  const params = context({ captionStyle: "punchy" }).params;
  const unaccented = plan({
    narrative_regime: "general",
    clips: [{
      source: "inputs/01_demo.mp4",
      kind: "video",
      visual_job: "problem",
      selection_reason: "The speaker points to the visible body bumps.",
      exit_condition: "The problem statement ends.",
      start: 3,
      end: 7,
      speed: 1,
      fit: "fill",
      mute: false,
    }],
    overlays: [{
      kind: "caption",
      start: 0,
      end: 2,
      text: "These body bumps changed my outfit",
      highlights: [],
      preset: "fine_caption",
      animation: "fade",
      effect_reason: "readability",
    }],
  });
  const snapshot = structuredClone(unaccented);
  const repaired = repairCaptionHighlightProsodyMotion(unaccented, params, [{
    source: "inputs/01_demo.mp4",
    start: 3.42,
    end: 3.64,
    text: "bumps",
    relativeEnergyDb: 4.6,
    prePauseSeconds: 0.14,
    postPauseSeconds: 0.03,
    level: "high",
  }]);

  assert.deepEqual(repaired.repairedOverlayIndices, [0]);
  assert.deepEqual(repaired.plan.overlays[0].highlights, [{
    text: "bumps",
    color: "#FF6B6B",
    motion: "shake",
    start: 0.42,
    end: 0.64,
  }]);
  assert.equal(repaired.plan.overlays[0].effect_reason, "pain");
  assert.deepEqual(unaccented, snapshot, "prosody repair must preserve its input");
  assert.doesNotThrow(() =>
    validateEditingModePlan(
      repaired.plan,
      params,
      ["These body bumps changed my outfit"],
      [{
        source: "inputs/01_demo.mp4",
        start: 3.42,
        end: 3.64,
        text: "bumps",
        relativeEnergyDb: 4.6,
        prePauseSeconds: 0.14,
        postPauseSeconds: 0.03,
        level: "high",
      }],
    ),
  );

  const alreadyPulsing = structuredClone(unaccented);
  alreadyPulsing.overlays[0].highlights = [{
    text: "bumps",
    color: "#FF6B6B",
    motion: "pulse",
    start: 0.42,
    end: 0.64,
  }];
  alreadyPulsing.overlays[0].effect_reason = "pain";
  const upgraded = repairCaptionHighlightProsodyMotion(alreadyPulsing, params, [{
    source: "inputs/01_demo.mp4",
    start: 3.42,
    end: 3.64,
    text: "bumps",
    relativeEnergyDb: 4.6,
    prePauseSeconds: 0.14,
    postPauseSeconds: 0.03,
    level: "high",
  }]);
  assert.equal(upgraded.plan.overlays[0].highlights[0].motion, "shake");
  assert.deepEqual(upgraded.repairedOverlayIndices, [0]);
});

test("the strongest spoken hook word may shake inside the large title", () => {
  const params = context({
    captionStyle: "punchy",
    editCaptions: "off",
  }).params;
  const input = plan({
    narrative_regime: "general",
    clips: [{
      source: "inputs/01_demo.mp4",
      kind: "video",
      visual_job: "hook",
      selection_reason: "The opening question names the visible body-bump problem.",
      exit_condition: "The opening question completes before the cut.",
      start: 1.94,
      end: 4.14,
      speed: 1,
      fit: "fill",
      mute: false,
    }],
    overlays: [{
      kind: "title",
      start: 0,
      end: 1.3,
      text: "Can we talk about body bumps",
      highlights: [],
      preset: "fine_hook",
      animation: "punch",
      effect_reason: "hook",
    }],
    transitions: [],
  });
  const cue = {
    source: "inputs/01_demo.mp4",
    start: 2.86,
    end: 3.06,
    text: "body",
    relativeEnergyDb: 4.11,
    prePauseSeconds: 0,
    postPauseSeconds: 0,
    level: "high",
  };
  const repaired = repairCaptionHighlightProsodyMotion(input, params, [cue]);
  assert.deepEqual(repaired.repairedOverlayIndices, [0]);
  assert.deepEqual(repaired.plan.overlays[0].highlights, [{
    text: "body",
    color: "#FFD84D",
    motion: "shake",
    start: 0.92,
    end: 1.12,
  }]);
  assert.doesNotThrow(() => validateAutoVideoEditPlan(repaired.plan, {
    ...context({ editCaptions: "off", editTargetDuration: 0 }),
    brief: "Can we talk about body bumps",
    transcriptTexts: ["Can we talk about body bumps"],
  }));
  assert.doesNotThrow(() => validateEditingModePlan(
    repaired.plan,
    params,
    ["Can we talk about body bumps"],
    [cue],
  ));
});

test("text enlargement and non-cut transitions require evidence-led reasons", () => {
  const smartParams = context({ editCaptions: "off", captionStyle: "punchy" }).params;
  const groundedHook = plan({
    overlays: [{
      kind: "title",
      start: 0,
      end: 1,
      text: "看这里",
      highlights: [],
      preset: "fine_hook",
      animation: "punch",
      effect_reason: "hook",
    }],
    transitions: [{
      after_clip: 0,
      type: "dissolve",
      duration: 0.2,
      reason: "soft_bridge",
    }],
  });
  assert.doesNotThrow(() => validateAutoVideoEditPlan(
    groundedHook,
    context({ editCaptions: "off", captionStyle: "punchy" }),
  ));
  assert.doesNotThrow(() => validateEditingModePlan(groundedHook, smartParams, []));

  const decorativeScale = structuredClone(groundedHook);
  decorativeScale.overlays[0].effect_reason = "readability";
  assert.throws(
    () => validateEditingModePlan(decorativeScale, smartParams, []),
    /文字放大|动态强调/u,
  );

  const unsupportedSlide = structuredClone(groundedHook);
  unsupportedSlide.transitions[0] = {
    after_clip: 0,
    type: "slide_left",
    duration: 0.2,
    reason: "soft_bridge",
  };
  assert.throws(
    () => validateAutoVideoEditPlan(
      unsupportedSlide,
      context({ editCaptions: "off", captionStyle: "punchy" }),
    ),
    /同方向运动证据/u,
  );

  const talkingParams = context({
    editMode: "talking_head",
    editCaptions: "off",
    transcribe: true,
  }).params;
  assert.throws(
    () => validateEditingModePlan(groundedHook, talkingParams, ["看这里"]),
    /口播.*特效转场/u,
  );
});

test("caption highlights and step components stay exact, sparse, and readable", () => {
  const params = context({ captionStyle: "punchy" }).params;
  const valid = plan({
    overlays: [
      {
        kind: "caption",
        start: 0,
        end: 2,
        text: "Y AYUDA A RETIRAR\nLA ACUMULACIÓN",
        highlights: [{ text: "RETIRAR", color: "#68E0C2" }],
        preset: "fine_caption",
        animation: "fade",
      },
      {
        kind: "label",
        start: 2,
        end: 3.2,
        text: "01",
        highlights: [],
        preset: "fine_step_number",
        animation: "tag",
      },
      {
        kind: "label",
        start: 2,
        end: 3.2,
        text: "APLICA",
        highlights: [],
        preset: "fine_step_action",
        animation: "slide_left",
      },
    ],
  });
  const transcript = ["Y AYUDA A RETIRAR LA ACUMULACIÓN"];
  const groundedContext = {
    ...context({ captionStyle: "punchy" }),
    brief: "Pasos: 01 APLICA",
    transcriptTexts: transcript,
  };
  assert.doesNotThrow(() => validateAutoVideoEditPlan(valid, groundedContext));
  assert.doesNotThrow(() => validateEditingModePlan(valid, params, transcript));

  const inventedHighlight = plan({
    overlays: [{
      kind: "caption",
      start: 0,
      end: 2,
      text: "Y AYUDA A RETIRAR LA ACUMULACIÓN",
      highlights: [{ text: "RESULTADO", color: "#68E0C2" }],
      preset: "fine_caption",
      animation: "fade",
    }],
  });
  assert.throws(
    () => validateAutoVideoEditPlan(inventedHighlight, groundedContext),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("局部连续短语")),
  );

  const paragraphCaption = plan({
    overlays: [{
      kind: "caption",
      start: 0,
      end: 5,
      text: "This entire transcript segment was pasted into one oversized caption card instead of being repaired into natural readable phrases",
      highlights: [{ text: "natural readable phrases", color: "#68E0C2" }],
      preset: "fine_caption",
      animation: "fade",
    }],
  });
  assert.throws(
    () => validateEditingModePlan(paragraphCaption, params, [paragraphCaption.overlays[0].text]),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("口播字幕过长")),
  );
});

test("caption highlight reasons are recovered from real words and active story jobs", () => {
  const original = plan({
    narrative_regime: "hybrid",
    clips: [
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        visual_job: "problem",
        selection_reason: "The speaker names visible body bumps.",
        exit_condition: "The problem statement ends.",
        start: 0,
        end: 3,
        speed: 1,
        fit: "fill",
        mute: false,
      },
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        visual_job: "feature",
        selection_reason: "The speaker names the product concentration.",
        exit_condition: "The 2% product statement ends.",
        start: 3,
        end: 6,
        speed: 1,
        fit: "fill",
        mute: false,
      },
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        visual_job: "payoff",
        selection_reason: "The speaker states the visible smoother result.",
        exit_condition: "The result statement ends.",
        start: 6,
        end: 9,
        speed: 1,
        fit: "fill",
        mute: false,
      },
    ],
    overlays: [
      {
        kind: "caption",
        start: 0,
        end: 3,
        text: "Can we talk about the body bumps?",
        highlights: [{ text: "body bumps", color: "#68E0C2" }],
        preset: "fine_caption",
        animation: "fade",
        effect_reason: "readability",
      },
      {
        kind: "caption",
        start: 3,
        end: 6,
        text: "I switched to this 2% body wash.",
        highlights: [{ text: "2%", color: "#68E0C2" }],
        preset: "fine_caption",
        animation: "fade",
        effect_reason: "readability",
      },
      {
        kind: "caption",
        start: 6,
        end: 9,
        text: "My arms and back are smoother.",
        highlights: [{ text: "smoother", color: "#68E0C2" }],
        preset: "fine_caption",
        animation: "fade",
        effect_reason: "readability",
      },
    ],
  });
  const snapshot = structuredClone(original);
  const repaired = repairCaptionHighlightEffectReasons(original);

  assert.deepEqual(repaired.repairedOverlayIndices, [0, 1, 2]);
  assert.deepEqual(repaired.unresolvedOverlayIndices, []);
  assert.deepEqual(
    repaired.plan.overlays.map((overlay) => overlay.effect_reason),
    ["pain", "number", "payoff"],
  );
  assert.deepEqual(original, snapshot, "semantic repair must not mutate the model draft");
  assert.doesNotThrow(() =>
    validateEditingModePlan(
      repaired.plan,
      context({ captionStyle: "punchy" }).params,
      [
        "Can we talk about the body bumps? I switched to this 2% body wash. My arms and back are smoother.",
      ],
    ),
  );
});

test("caption highlight repair does not invent a semantic reason for decoration", () => {
  const decorative = plan({
    narrative_regime: "general",
    clips: [
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        visual_job: "setup",
        selection_reason: "The speaker establishes the location.",
        exit_condition: "The setup sentence ends.",
        start: 0,
        end: 3,
        speed: 1,
        fit: "fill",
        mute: false,
      },
    ],
    overlays: [
      {
        kind: "caption",
        start: 0,
        end: 2,
        text: "This is the room where I filmed it.",
        highlights: [{ text: "the", color: "#68E0C2" }],
        preset: "fine_caption",
        animation: "fade",
        effect_reason: "readability",
      },
    ],
  });
  const repaired = repairCaptionHighlightEffectReasons(decorative);
  assert.equal(repaired.plan, decorative);
  assert.deepEqual(repaired.repairedOverlayIndices, []);
  assert.deepEqual(repaired.unresolvedOverlayIndices, [0]);
});

test("task 164 transcript accents resolve to distinct editorial reasons", () => {
  const clip = (visual_job, start, end) => ({
    source: "inputs/01_demo.mp4",
    kind: "video",
    visual_job,
    selection_reason: `The ${visual_job} statement is visible or spoken here.`,
    exit_condition: `The ${visual_job} statement ends.`,
    start,
    end,
    speed: 1,
    fit: "fill",
    mute: false,
  });
  const overlay = (text, highlight, start, end) => ({
    kind: "caption",
    start,
    end,
    text,
    highlights: [{ text: highlight, color: "#68E0C2" }],
    preset: "fine_caption",
    animation: "fade",
    effect_reason: "readability",
  });
  const task164Shape = plan({
    clips: [
      clip("hook", 0, 4),
      clip("problem", 4, 6),
      clip("feature", 6, 10),
      clip("proof", 10, 16),
      clip("progress", 16, 18),
      clip("payoff", 18, 22),
      clip("comparison", 22, 25),
    ],
    overlays: [
      overlay("Can we talk about the body bumps?", "body bumps", 0, 4),
      overlay("I still hide my shoulders.", "hide my shoulders", 4, 6),
      overlay("I switched to this 2% body wash.", "2%", 6, 10),
      overlay("It has salicynic acid.", "salicynic acid", 10, 16),
      overlay("I used it consistently.", "consistently", 16, 18),
      overlay("My arms and back are smoother.", "smoother", 18, 21),
      overlay("I'm finally wearing the dress.", "finally", 21, 22),
      overlay("My routine wasn't.", "wasn't", 22, 25),
    ],
  });

  const repaired = repairCaptionHighlightEffectReasons(task164Shape);
  assert.deepEqual(repaired.unresolvedOverlayIndices, []);
  assert.deepEqual(
    repaired.plan.overlays.map((item) => item.effect_reason),
    ["hook", "pain", "number", "proof", "proof", "payoff", "payoff", "contrast"],
  );
});

test("task 165 caption format is repaired without losing words, timing, or semantic accents", () => {
  const shortText = "So I switched to this 2% salicynic acid body wash.";
  const longText = "This loother has salicynic acid to help unclog pores and exfoliate the build up behind bumpy skin.";
  const task165Shape = plan({
    narrative_regime: "product_proof",
    clips: [
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        visual_job: "feature",
        selection_reason: "The speaker identifies the 2% product concentration.",
        exit_condition: "The product statement ends.",
        start: 0,
        end: 4,
        speed: 1,
        fit: "fill",
        mute: false,
      },
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        visual_job: "proof",
        selection_reason: "The speaker explains the supplied ingredient and cleansing action.",
        exit_condition: "The ingredient explanation ends.",
        start: 4,
        end: 10,
        speed: 1,
        fit: "fill",
        mute: false,
      },
    ],
    overlays: [
      {
        kind: "caption",
        start: 0,
        end: 4,
        text: shortText,
        highlights: [{ text: "2%", color: "#68E0C2" }],
        preset: "fine_accent",
        animation: "bounce",
        effect_reason: "number",
      },
      {
        kind: "caption",
        start: 4,
        end: 10,
        text: longText,
        highlights: [{ text: "salicynic acid", color: "#68E0C2" }],
        preset: "fine_caption",
        animation: "fade",
        effect_reason: "proof",
      },
    ],
  });
  const snapshot = structuredClone(task165Shape);
  const repaired = repairEditingCaptionReadability(task165Shape);
  const captions = repaired.plan.overlays;

  assert.deepEqual(repaired.normalizedOverlayIndices, [0]);
  assert.deepEqual(repaired.splitOverlayIndices, [1]);
  assert.deepEqual(repaired.unresolvedOverlayIndices, []);
  assert.equal(captions[0].preset, "fine_caption");
  assert.equal(captions[0].animation, "fade");
  assert.deepEqual(captions[0].highlights, [{ text: "2%", color: "#68E0C2" }]);
  assert.equal(captions[0].effect_reason, "number");
  assert.equal(captions.length, 3);
  assert.equal(captions[1].start, 4);
  assert.equal(captions[2].end, 10);
  assert.equal(captions[1].end, captions[2].start);
  assert.equal(
    captions.slice(1).map((caption) => caption.text).join(" "),
    longText,
  );
  assert.equal(
    captions.slice(1).flatMap((caption) => caption.highlights).length,
    1,
  );
  for (const caption of captions) {
    assert.ok(caption.text.split(/\s+/u).length <= 12);
    assert.ok(caption.text.length <= 72);
    assert.ok(["none", "fade"].includes(caption.animation));
  }
  assert.deepEqual(task165Shape, snapshot, "caption repair must not mutate the model draft");
  const params = context({ captionStyle: "punchy", editTargetDuration: 0 }).params;
  const groundedContext = {
    ...context({ captionStyle: "punchy", editTargetDuration: 0 }),
    transcriptTexts: [`${shortText} ${longText}`],
  };
  assert.doesNotThrow(() => validateAutoVideoEditPlan(repaired.plan, groundedContext));
  assert.doesNotThrow(() =>
    validateEditingModePlan(repaired.plan, params, groundedContext.transcriptTexts),
  );
});

test("task 167 one-word caption tail is merged before render", () => {
  const task167Shape = plan({
    narrative_regime: "product_proof",
    clips: [
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        visual_job: "action",
        selection_reason: "The speaker demonstrates the product while explaining the skin concern.",
        exit_condition: "The explanation phrase ends.",
        start: 0,
        end: 14,
        speed: 1,
        fit: "fill",
        mute: false,
      },
    ],
    overlays: [
      {
        kind: "caption",
        start: 10.92,
        end: 12.1,
        text: "the build up behind bumpy",
        highlights: [],
        preset: "fine_caption",
        animation: "fade",
        effect_reason: "readability",
        x: 0.5,
        y: 0.76,
        align: 5,
        layer: 10,
      },
      {
        kind: "caption",
        start: 12.1,
        end: 12.36,
        text: "skin.",
        highlights: [],
        preset: "fine_caption",
        animation: "fade",
        effect_reason: "readability",
        x: 0.5,
        y: 0.76,
        align: 5,
        layer: 10,
      },
    ],
  });
  const repaired = repairEditingCaptionReadability(task167Shape);
  const captions = repaired.plan.overlays;

  assert.equal(repaired.mergedCaptionCount, 1);
  assert.equal(captions.length, 1);
  assert.equal(captions[0].start, 10.92);
  assert.equal(captions[0].end, 12.36);
  assert.equal(captions[0].text, "the build up behind bumpy skin.");
  assert.deepEqual(captions[0].highlights, []);
  const params = context({ captionStyle: "clean", editTargetDuration: 0 }).params;
  const splitTranscript = ["the build up behind bumpy", "skin."];
  assert.doesNotThrow(() => validateAutoVideoEditPlan(repaired.plan, {
    ...context({ captionStyle: "clean", editTargetDuration: 0 }),
    transcriptTexts: splitTranscript,
  }));
  assert.doesNotThrow(() => validateEditingModePlan(repaired.plan, params, splitTranscript));
});

test("a one-word leading caption is merged forward instead of failing task 169", () => {
  const input = plan({
    narrative_regime: "product_proof",
    overlays: [
      {
        kind: "caption",
        start: 0,
        end: 0.22,
        text: "So",
        highlights: [],
        preset: "default",
        animation: "none",
        effect_reason: "readability",
        x: 0.5,
        y: 0.74,
        align: 5,
        layer: 10,
      },
      {
        kind: "caption",
        start: 0.22,
        end: 2.2,
        text: "I switched to this body wash.",
        highlights: [],
        preset: "fine_caption",
        animation: "fade",
        effect_reason: "readability",
        x: 0.5,
        y: 0.76,
        align: 5,
        layer: 11,
      },
    ],
  });
  const repaired = repairEditingCaptionReadability(input);
  assert.equal(repaired.mergedCaptionCount, 1);
  assert.equal(repaired.plan.overlays.length, 1);
  assert.equal(repaired.plan.overlays[0].text, "So I switched to this body wash.");
  assert.equal(repaired.plan.overlays[0].start, 0);
  assert.equal(repaired.plan.overlays[0].end, 2.2);
});

test("caption repair never joins a completed question to the answer or crosses a hard cut", () => {
 const p=plan({clips:[{kind:'video',source:'inputs/01_demo.mp4',start:0,end:1,speed:1},{kind:'video',source:'inputs/01_demo.mp4',start:2,end:5,speed:1}],overlays:[
  {kind:'caption',text:'Why?',start:.7,end:1,x:.5,y:.76,align:5},
  {kind:'caption',text:'Because it works.',start:1,end:2,x:.5,y:.76,align:5}
 ]});
 const fixed=repairEditingCaptionReadability(p);
 assert.equal(fixed.mergedCaptionCount,0);
 assert.ok(fixed.plan.overlays[0].end<=1);
 p.overlays[0].text='So';
 assert.equal(repairEditingCaptionReadability(p).mergedCaptionCount,0);
 p.clips=[{kind:'video',source:'inputs/01_demo.mp4',start:0,end:5,speed:1}];
 p.overlays[0].text='Why?';
 assert.equal(repairEditingCaptionReadability(p).mergedCaptionCount,0);
});

test("an isolated short caption expands only into free timeline space", () => {
  const input = plan({
    narrative_regime: "product_proof",
    clips: [{
      source: "inputs/01_demo.mp4",
      kind: "video",
      visual_job: "hook",
      selection_reason: "The opening word is audible in the supplied transcript.",
      exit_condition: "The opening reaction completes.",
      start: 0,
      end: 3,
      speed: 1,
      fit: "fill",
      mute: false,
    }],
    overlays: [{
      kind: "caption",
      start: 0.4,
      end: 0.58,
      text: "Why?",
      highlights: [],
      preset: "fine_caption",
      animation: "fade",
      effect_reason: "readability",
      x: 0.5,
      y: 0.76,
      align: 5,
      layer: 10,
    }],
  });
  const repaired = repairEditingCaptionReadability(input);
  assert.equal(repaired.mergedCaptionCount, 0);
  assert.equal(repaired.adjustedCaptionCount, 1);
  assert.equal(repaired.plan.overlays[0].start, 0.4);
  assert.equal(repaired.plan.overlays[0].end, 0.78);
  assert.doesNotThrow(() => validateEditingModePlan(
    repaired.plan,
    context({ editTargetDuration: 0 }).params,
    ["Why?"],
  ));
});

test("caption timing gate blocks flashes but leaves suboptimal readable timing as a warning", () => {
  const params = context({ editTargetDuration: 0 }).params;
  const readableWarning = plan({
    narrative_regime: "general",
    clips: [{
      source: "inputs/01_demo.mp4",
      kind: "video",
      visual_job: "hook",
      selection_reason: "The supplied speaker says the opening phrase.",
      exit_condition: "The opening phrase completes.",
      start: 0,
      end: 3,
      speed: 1,
      fit: "fill",
      mute: false,
    }],
    overlays: [{
      kind: "caption",
      start: 0,
      end: 0.3,
      text: "Look here",
      highlights: [],
      preset: "fine_caption",
      animation: "fade",
      effect_reason: "readability",
    }],
  });
  assert.doesNotThrow(() => validateEditingModePlan(readableWarning, params, ["Look here"]));
  const flash = structuredClone(readableWarning);
  flash.overlays[0].end = 0.2;
  assert.throws(
    () => validateEditingModePlan(flash, params, ["Look here"]),
    /短于0\.28秒/u,
  );
});

test("overlay placement uses paired normalized output coordinates", () => {
  const params = context({ editCaptions: "off" }).params;
  const normalized = plan({
    overlays: [{
      kind: "title",
      start: 0,
      end: 1,
      text: "看这里",
      preset: "default",
      animation: "fade",
      x: 0.5,
      y: 0.14,
      align: 5,
    }],
  });
  assert.doesNotThrow(() => validateAutoVideoEditPlan(normalized, context({ editCaptions: "off" })));
  assert.doesNotThrow(() => validateEditingModePlan(normalized, params, []));

  for (const invalid of [
    { ...normalized.overlays[0], x: 540, y: 0.14 },
    { ...normalized.overlays[0], y: undefined },
  ]) {
    assert.throws(
      () => validateAutoVideoEditPlan(plan({ overlays: [invalid] }), context({ editCaptions: "off" })),
      EditingPlanSchemaError,
    );
  }
});

test("talking-head plans enforce natural speech speed, restrained motion, and clean finishing", () => {
  const params = context({
    editMode: "talking_head",
    captionStyle: "clean",
  }).params;
  const valid = plan({
    finishing: { preset: "none", flashes: [] },
    clips: [{
      source: "inputs/01_demo.mp4",
      kind: "video",
      start: 1,
      end: 5,
      speed: 1.1,
      fit: "fill",
      mute: false,
      motion: {
        zoom_start: 1.06,
        zoom_end: 1.18,
        focus_x_start: 0.5,
        focus_x_end: 0.5,
        focus_y_start: 0.5,
        focus_y_end: 0.5,
      },
    }],
  });
  assert.doesNotThrow(() => validateEditingModePlan(valid, params, ["看这里"]));

  const unsafe = plan({
    finishing: {
      preset: "commerce_pop",
      flashes: [{ start: 0, duration: 0.05, color: "white", alpha: 0.2 }],
    },
    clips: [{
      source: "inputs/01_demo.mp4",
      kind: "video",
      start: 1,
      end: 1.2,
      speed: 1.2,
      fit: "fill",
      mute: false,
      motion: {
        zoom_start: 1,
        zoom_end: 1.25,
        focus_x_start: 0.5,
        focus_x_end: 0.5,
        focus_y_start: 0.5,
        focus_y_end: 0.5,
      },
    }],
  });
  assert.throws(
    () => validateEditingModePlan(unsafe, params, ["看这里"]),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("短于 0.35 秒")) &&
      error.issues.some((issue) => issue.includes("0.9–1.1")) &&
      error.issues.some((issue) => issue.includes("缩放变化")) &&
      error.issues.some((issue) => issue.includes("commerce_pop")) &&
      error.issues.some((issue) => issue.includes("闪屏")),
  );
});

test("digital-presenter plans preserve source timing and reject muted-only speech", () => {
  const params = context({
    editMode: "digital_presenter",
    editCaptions: "off",
  }).params;
  const valid = plan({
    overlays: [],
    finishing: { preset: "none", flashes: [] },
    clips: [{
      source: "inputs/01_demo.mp4",
      kind: "video",
      start: 1,
      end: 5,
      speed: 1.01,
      fit: "fill",
      mute: false,
      motion: {
        zoom_start: 1.03,
        zoom_end: 1.08,
        focus_x_start: 0.5,
        focus_x_end: 0.5,
        focus_y_start: 0.5,
        focus_y_end: 0.5,
      },
    }],
  });
  assert.doesNotThrow(() => validateEditingModePlan(valid, params, ["看这里"]));

  const unsafe = plan({
    overlays: [],
    finishing: { preset: "none", flashes: [] },
    clips: [{
      source: "inputs/01_demo.mp4",
      kind: "video",
      start: 1,
      end: 5,
      speed: 1.02,
      fit: "fill",
      mute: true,
      motion: {
        zoom_start: 1,
        zoom_end: 1.09,
        focus_x_start: 0.5,
        focus_x_end: 0.5,
        focus_y_start: 0.5,
        focus_y_end: 0.5,
      },
    }],
  });
  assert.throws(
    () => validateEditingModePlan(unsafe, params, ["看这里"]),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("1 倍")) &&
      error.issues.some((issue) => issue.includes("未静音")) &&
      error.issues.some((issue) => issue.includes("缩放变化")),
  );
});

test("product-demo plans normalize commercial finishing without changing smart mode", () => {
  const productParams = context({ editMode: "product_demo" }).params;
  const input = plan();
  const product = validateEditingModePlan(input, productParams, ["看这里"]);
  assert.equal(product.finishing.preset, "commerce_pop");
  assert.deepEqual(product.finishing.flashes, []);
  assert.equal(product.finishing.loudness_target_lufs, -13);
  assert.equal(product.finishing.true_peak_limit_db, -1);
  assert.equal(input.finishing, undefined, "validation must not mutate the model plan");

  const tooManyFlashes = plan({
    finishing: {
      preset: "none",
      flashes: [0, 1, 2].map((start) => ({
        start,
        duration: 0.05,
        color: "white",
        alpha: 0.2,
      })),
    },
  });
  assert.throws(
    () => validateEditingModePlan(tooManyFlashes, productParams, ["看这里"]),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("最多使用两次")),
  );

  const smart = validateEditingModePlan(
    plan({ finishing: { preset: "none", flashes: [] } }),
    context({ editMode: "smart" }).params,
    ["看这里"],
  );
  assert.equal(smart.finishing.preset, "none");
  assert.equal(smart.finishing.loudness_target_lufs, -14);
  assert.equal(smart.finishing.true_peak_limit_db, -1.5);
});

test("current plans bind each retained clip and effect to an evidence-led story job", () => {
  const mapped = plan({
    narrative_regime: "product_proof",
    clips: [
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        visual_job: "problem",
        selection_reason: "The source visibly demonstrates the problem before the product appears.",
        exit_condition: "The visible problem is established and the hand leaves frame.",
        start: 2,
        end: 8,
        speed: 1,
        fit: "fill",
        audio_gain_db: 0,
        mute: false,
      },
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        visual_job: "action",
        selection_reason: "The hand completes the demonstrated product-use action in one continuous span.",
        exit_condition: "The application action finishes and the hand settles.",
        start: 8,
        end: 14,
        speed: 1,
        fit: "fill",
        audio_gain_db: 0,
        mute: false,
      },
      {
        source: "inputs/02_product.png",
        kind: "image",
        visual_job: "identity",
        selection_reason: "The supplied still makes the real package identity readable for the ending.",
        exit_condition: "The package has held long enough to read before the video ends.",
        start: 0,
        end: 0,
        duration: 3,
        speed: 1,
        fit: "contain",
        audio_gain_db: 0,
        mute: true,
        motion: null,
      },
    ],
    overlays: [
      {
        kind: "label",
        start: 6.2,
        end: 7.2,
        text: "看这里",
        effect_reason: "step",
        preset: "badge",
        animation: "tag",
        highlights: [],
      },
    ],
  });
  const params = normalizeEditingPlanParameters({
    editMode: "product_demo",
    editTargetDuration: 15,
    editAspect: "vertical",
    editCaptions: "off",
    captionStyle: "punchy",
    editAudio: "keep",
    transcribe: false,
  });
  assert.doesNotThrow(() => validateEditingModePlan(mapped, params, []));

  const wrongEffect = structuredClone(mapped);
  wrongEffect.overlays[0].effect_reason = "pain";
  assert.throws(
    () => validateEditingModePlan(wrongEffect, params, []),
    /没有落在相符的画面叙事节点/u,
  );

  const earlyCta = structuredClone(mapped);
  earlyCta.clips[0].visual_job = "cta";
  assert.throws(
    () => validateEditingModePlan(earlyCta, params, []),
    /开场不能用过桥空镜或 CTA/u,
  );
});

test("repeated camera templates are deterministically collapsed before the normal gate", () => {
  const durations = [1, 1.3, 1.7, 2.2, 1.1, 1.5, 2, 2.4];
  let cursor = 0;
  const clips = durations.map((duration) => {
    const start = cursor;
    cursor += duration + 0.1;
    return {
      source: "inputs/01_demo.mp4",
      kind: "video",
      start,
      end: start + duration,
      speed: 1,
      fit: "fill",
      audio_gain_db: 0,
      mute: true,
      motion: {
        zoom_start: 1,
        zoom_end: 1.08,
        focus_x_start: 0.5,
        focus_x_end: 0.5,
        focus_y_start: 0.5,
        focus_y_end: 0.5,
      },
    };
  });
  const original = plan({ clips, overlays: [] });
  const params = context({ editCaptions: "off", editAudio: "mute", transcribe: false }).params;
  assert.throws(
    () => validateEditingModePlan(original, params, []),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("同一套推拉模板")),
  );

  const first = repairRepeatedEditingMotionTemplates(original);
  const second = repairRepeatedEditingMotionTemplates(original);
  const idempotent = repairRepeatedEditingMotionTemplates(first.plan);
  assert.deepEqual(first, second, "repair must be deterministic");
  assert.equal(idempotent.removedCount, 0);
  assert.deepEqual(idempotent.plan, first.plan, "repair must be idempotent");
  assert.equal(first.removedCount, 7);
  assert.ok(first.plan.clips[0].motion, "one intentional opening emphasis may remain");
  assert.equal(first.plan.clips.at(-1).motion, undefined, "the hero ending must stay stable");
  assert.ok(original.clips.every((clip) => clip.motion), "repair must not mutate the model plan");
  assert.deepEqual(
    first.plan.clips.map(({ motion: _motion, ...clip }) => clip),
    original.clips.map(({ motion: _motion, ...clip }) => clip),
    "repair must not change story, timing, crop, or audio controls",
  );
  assert.doesNotThrow(() => validateEditingModePlan(first.plan, params, []));
});

test("no-op structured-output motions are removed without touching real sparse motion", () => {
  const input = plan({
    clips: [
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        start: 1,
        end: 3,
        speed: 1,
        fit: "fill",
        mute: true,
        motion: {
          zoom_start: 1,
          zoom_end: 1,
          focus_x_start: 0.5,
          focus_x_end: 0.5,
          focus_y_start: 0.5,
          focus_y_end: 0.5,
        },
      },
      {
        source: "inputs/02_product.png",
        kind: "image",
        duration: 2,
        fit: "contain",
        motion: {
          zoom_start: 1,
          zoom_end: 1.06,
          focus_x_start: 0.5,
          focus_x_end: 0.5,
          focus_y_start: 0.5,
          focus_y_end: 0.5,
        },
      },
    ],
  });
  const repaired = repairRepeatedEditingMotionTemplates(input);
  assert.equal(repaired.removedCount, 1);
  assert.equal(repaired.plan.clips[0].motion, undefined);
  assert.deepEqual(repaired.plan.clips[1].motion, input.clips[1].motion);
});

test("static zoom crops and sparse repeated motions remain intact", () => {
  const staticCrop = {
    zoom_start: 1.2,
    zoom_end: 1.2,
    focus_x_start: 0.55,
    focus_x_end: 0.55,
    focus_y_start: 0.5,
    focus_y_end: 0.5,
  };
  const repeated = {
    zoom_start: 1,
    zoom_end: 1.08,
    focus_x_start: 0.5,
    focus_x_end: 0.5,
    focus_y_start: 0.5,
    focus_y_end: 0.5,
  };
  const clips = Array.from({ length: 8 }, (_value, index) => ({
    source: "inputs/01_demo.mp4",
    kind: "video",
    start: index * 2,
    end: index * 2 + 1 + index * 0.07,
    speed: 1,
    fit: "fill",
    mute: true,
    ...(index === 0
      ? { motion: staticCrop }
      : index < 3
        ? { motion: repeated }
        : {}),
  }));
  const input = plan({ clips, overlays: [] });
  const repaired = repairRepeatedEditingMotionTemplates(input);
  assert.equal(repaired.removedCount, 0);
  assert.deepEqual(repaired.plan, input);
});

test("editing plan accepts only an evidence-backed executable timeline", () => {
  const result = validateAutoVideoEditPlan(plan(), context());
  assert.equal(result.job_id, "job-1");
  assert.equal(result.clips.length, 2);
});

test("picture-in-picture uses only supplied visuals and stays inside one non-overlapping layer", () => {
  const inset = {
    source: "inputs/02_product.png",
    kind: "image",
    start: 2,
    end: 4,
    source_start: 0,
    source_end: 2,
    x: 0.58,
    y: 0.08,
    width: 0.34,
    height: 0.28,
    fit: "contain",
    selection_reason: "产品图与当前口播中的产品展示属于同一信息节拍",
    callout_side: "left",
  };
  const accepted = validateAutoVideoEditPlan(
    plan({ picture_in_picture: [inset] }),
    context(),
  );
  assert.equal(accepted.picture_in_picture.length, 1);
  assert.equal(accepted.picture_in_picture[0].callout_side, "left");

  assert.throws(
    () => validateAutoVideoEditPlan(
      plan({ picture_in_picture: [{ ...inset, x: 0.04 }] }),
      context(),
    ),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("左侧没有足够空间")),
  );

  assert.throws(
    () => validateAutoVideoEditPlan(
      plan({ picture_in_picture: [{ ...inset, x: 0.8 }] }),
      context(),
    ),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("右边界")),
  );
  assert.throws(
    () => validateAutoVideoEditPlan(
      plan({
        picture_in_picture: [
          inset,
          { ...inset, start: 3.5, end: 5.5, source_end: 2 },
        ],
      }),
      context(),
    ),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("不得同时叠加")),
  );
});

test("editing plan rejects invented audio and clip sources", () => {
  const invalid = plan({
    music: { source: "inputs/invented.mp3", volume_db: -18, ducking: true },
  });
  assert.throws(
    () => validateAutoVideoEditPlan(invalid, context()),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("music.source")),
  );

  const inventedClip = plan({
    clips: [
      {
        source: "inputs/invented.mp4",
        kind: "video",
        start: 0,
        end: 15,
      },
    ],
  });
  assert.throws(
    () => validateAutoVideoEditPlan(inventedClip, context()),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("source")),
  );
});

test("editing plan rejects clips that overlap measured in-frame roll and accepts safe spans", () => {
  const guardedSources = sources.map((source) =>
    source.source === "inputs/01_demo.mp4"
      ? {
          ...source,
          unsafeRollSegments: [{
            start: 2.2,
            end: 8.467,
            maxAbsDegrees: 76.09,
            confidence: 0.91,
          }],
        }
      : source,
  );
  const guardedContext = {
    ...context({ editTargetDuration: 0 }),
    sources: guardedSources,
  };
  assert.throws(
    () => validateAutoVideoEditPlan(plan(), guardedContext),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("片内横倒禁用区间")),
  );

  const safe = plan({
    clips: [
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        start: 8.7,
        end: 12,
        speed: 1,
        fit: "fill",
        mute: false,
      },
      {
        source: "inputs/02_product.png",
        kind: "image",
        duration: 5,
        fit: "contain",
      },
    ],
  });
  assert.doesNotThrow(() => validateAutoVideoEditPlan(safe, guardedContext));
});

test("editing plan rejects task 166 source black before rendering", () => {
  const guardedSources = sources.map((source) =>
    source.source === "inputs/01_demo.mp4"
      ? {
          ...source,
          unsafeBlackSegments: [{
            start: 16.792,
            end: 19.167,
            duration: 2.375,
          }],
        }
      : source,
  );
  const guardedContext = {
    ...context({ editTargetDuration: 0 }),
    sources: guardedSources,
  };
  const overlapping = plan({
    clips: [{
      source: "inputs/01_demo.mp4",
      kind: "video",
      start: 15.8,
      end: 20.1,
      speed: 1,
      fit: "fill",
      mute: false,
    }],
    overlays: [],
  });
  assert.throws(
    () => validateAutoVideoEditPlan(overlapping, guardedContext),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("素材黑场禁用区间 16.71–19.25s")),
  );

  const safe = plan({
    clips: [
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        start: 12,
        end: 16.7,
        speed: 1,
        fit: "fill",
        mute: false,
      },
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        start: 19.3,
        end: 22,
        speed: 1,
        fit: "fill",
        mute: false,
      },
    ],
    overlays: [],
  });
  assert.doesNotThrow(() => validateAutoVideoEditPlan(safe, guardedContext));
});

test("every overlay text must come from transcript or the employee brief", () => {
  for (const kind of ["title", "caption", "label"]) {
    const invalid = plan({
      overlays: [
        { kind, start: 0, end: 2, text: "凭空编造的宣传承诺 99% 认证" },
      ],
    });
    assert.throws(
      () => validateAutoVideoEditPlan(invalid, context()),
      (error) =>
        error instanceof EditingPlanSchemaError &&
        error.issues.some((issue) => issue.includes(".text")),
      `${kind} must be grounded`,
    );
  }

  const groundedTitle = plan({
    overlays: [{ kind: "title", start: 0, end: 2, text: "看这里" }],
  });
  assert.equal(validateAutoVideoEditPlan(groundedTitle, context()).overlays.length, 1);
});

test("the internal one-click fine-edit brief can never become visible copy", () => {
  const internalWorkflowCopy = plan({
    overlays: [{ kind: "title", start: 0, end: 2, text: "自动精剪" }],
  });
  assert.throws(
    () =>
      validateAutoVideoEditPlan(internalWorkflowCopy, {
        ...context(),
        brief: AUTO_EDIT_DEFAULT_BRIEF,
        transcriptTexts: ["This is the real spoken line."],
      }),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes(".text")),
  );
});

test("output preset matches AutoLab's native encoder allowlist", () => {
  const schema = buildAutoVideoEditPlanSchema({
    visualSources: ["inputs/01_demo.mp4"],
    audioSources: [],
  });
  assert.deepEqual(schema.properties.output.properties.preset.enum, [
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
    "p1",
    "p2",
    "p3",
    "p4",
    "p5",
    "p6",
    "p7",
  ]);
  const invalid = plan({
    output: { ...plan().output, preset: "turbo" },
  });
  assert.throws(
    () => validateAutoVideoEditPlan(invalid, context()),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("output.preset")),
  );
});

test("source aspect preserves the actual ratio within one percent", () => {
  const sourceContext = context({ editAspect: "source" });
  const preserved = plan({
    output: { ...plan().output, width: 1280, height: 720 },
  });
  assert.equal(validateAutoVideoEditPlan(preserved, sourceContext).output.width, 1280);

  const changed = plan({
    output: { ...plan().output, width: 1440, height: 1080 },
  });
  assert.throws(
    () => validateAutoVideoEditPlan(changed, sourceContext),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("宽高比")),
  );
});

test("editing lab boundary uses the explicit physical root and direct job child", () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-editing-boundary-"));
  const labRoot = path.join(testRoot, "lab");
  const jobsRoot = path.join(labRoot, "jobs");
  const jobRoot = path.join(jobsRoot, "job-1");
  const outsideJob = path.join(testRoot, "outside-job");
  fs.mkdirSync(jobRoot, { recursive: true });
  fs.mkdirSync(outsideJob);
  try {
    const boundary = resolveEditingLabBoundary({ labRoot, jobRoot });
    assert.equal(boundary.labRoot, fs.realpathSync.native(labRoot));
    assert.equal(boundary.jobsRoot, fs.realpathSync.native(jobsRoot));
    assert.equal(boundary.jobRoot, fs.realpathSync.native(jobRoot));
    assert.throws(
      () => resolveEditingLabBoundary({ labRoot, jobRoot: outsideJob }),
      /直接子目录/u,
    );
    assert.throws(
      () => resolveEditingLabBoundary({ labRoot: "relative-lab", jobRoot }),
      /绝对路径/u,
    );
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("mute and caption-off preferences are enforced after structured output", () => {
  assert.throws(
    () =>
      validateAutoVideoEditPlan(
        plan(),
        context({ editAudio: "mute", editCaptions: "off" }),
      ),
    (error) =>
      error instanceof EditingPlanSchemaError &&
      error.issues.some((issue) => issue.includes("mute=true")) &&
      error.issues.some((issue) => issue.includes("caption")),
  );
});

test("task-specific output schema narrows visual and audio source values", () => {
  const schema = buildAutoVideoEditPlanSchema({
    visualSources: ["inputs/01_demo.mp4", "inputs/02_product.png"],
    audioSources: ["inputs/03_music.wav"],
  });
  assert.deepEqual(
    schema.properties.clips.items.properties.source.enum,
    ["inputs/01_demo.mp4", "inputs/02_product.png"],
  );
  assert.deepEqual(
    schema.properties.picture_in_picture.items.properties.source.enum,
    ["inputs/01_demo.mp4", "inputs/02_product.png"],
  );
  assert.equal(schema.required.includes("picture_in_picture"), true);
  assert.equal(
    schema.properties.picture_in_picture.items.required.includes("callout_side"),
    true,
  );
  assert.equal(schema.required.includes("narrative_regime"), true);
  assert.equal(
    schema.properties.clips.items.required.includes("visual_job"),
    true,
  );
  assert.deepEqual(
    schema.properties.music.properties.source.enum,
    ["inputs/03_music.wav"],
  );

  const withoutAudio = buildAutoVideoEditPlanSchema({
    visualSources: ["inputs/01_demo.mp4"],
    audioSources: [],
  });
  assert.deepEqual(withoutAudio.properties.music, { type: "null" });
  assert.equal(withoutAudio.properties.sfx.maxItems, 0);
});

test("Codex strict schema requires every declared object property", () => {
  const schema = buildAutoVideoEditPlanSchema({
    visualSources: ["inputs/01_demo.mp4", "inputs/02_product.png"],
    audioSources: ["inputs/03_music.wav"],
  });
  const visit = (node, location = "schema") => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    if (node.type === "object" && node.properties) {
      assert.deepEqual(
        [...node.required].sort(),
        Object.keys(node.properties).sort(),
        `${location} must require every property for strict structured output`,
      );
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "required") continue;
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, `${location}.${key}[${index}]`));
      } else {
        visit(value, `${location}.${key}`);
      }
    }
  };
  visit(schema);
});
