import assert from "node:assert/strict";
import test from "node:test";
import {
  consolidatePromptAssetBindings,
  briefClaimsUploadedCharacterReference,
  briefClaimsUploadedProductReference,
  briefRequestsProductScienceAnimation,
  containsInternalWorkflowLanguage,
  ensurePromptAssetBindings,
  ensurePromptContinuityStrategy,
  ensureStrongProductFidelityLanguage,
  explicitSpokenLanguageFromBrief,
  hasSafeCleanProductGenerationLanguage,
  hasStrongProductFidelityLanguage,
  inspectPromptAssetBindings,
  inspectCharacterIdentityTextLock,
  inspectDefaultEnglishSpokenLanguage,
  inspectPromptCinematography,
  inspectPromptConcision,
  inspectPromptExecutability,
  inspectPromptPageOnlyControls,
  inspectPromptQualityPlan,
  inspectShortViralPromptComplexity,
  inspectPromptTemporalClarity,
  isProductIdentityResponsibility,
  isNonBlockingFinalPromptQualityIssue,
  isNonBlockingUnderstandingQualityIssue,
  ensureReferenceDecisionFramework,
  parsePromptTimeRange,
  promptContainsTimeRange,
  repairPromptQualityAnchors,
  stripPromptPageOnlyControls,
} from "../lib/seedance-prompt-policy.ts";
import { selectFinalSeedancePrompt } from "../lib/seedance-prompt-display.ts";
import { inspectPromptTranslation } from "../lib/prompt-translation-policy.ts";
import {
  extractInputReferenceMentions,
  parseInputImageLabels,
} from "../lib/input-reference-labels.ts";

test("input reference labels stay explicit and unambiguous", () => {
  assert.deepEqual(
    parseInputImageLabels('["参考图片1","参考图片3"]', 2),
    ["参考图片1", "参考图片3"],
  );
  assert.equal(parseInputImageLabels('["参考图片1","参考图片1"]', 2), null);
  assert.deepEqual(
    extractInputReferenceMentions(
      "【参考视频1】保留节奏，参考图片3是产品，参考图2是人物。",
    ).map(({ type, number, label }) => ({ type, number, label })),
    [
      { type: "video", number: 1, label: "参考视频1" },
      { type: "image", number: 3, label: "参考图片3" },
      { type: "image", number: 2, label: "参考图片2" },
    ],
  );
});

test("spoken language defaults to English unless the brief explicitly overrides it", () => {
  const brief =
    "保留开头，把产品换成我的沐浴露，口播提到水杨酸沐浴露的日常清洁内容。";
  assert.equal(explicitSpokenLanguageFromBrief(brief), null);
  assert.match(
    inspectDefaultEnglishSpokenLanguage(
      "制作30秒中文口播短片。0–5秒：男人说：“先看你的日常清洁。”",
      brief,
    ).join("\n"),
    /口播默认语言错误/u,
  );
  assert.deepEqual(
    inspectDefaultEnglishSpokenLanguage(
      "制作30秒短片，全片使用自然英语口播。0–5秒：男人说：“Start with your everyday body-cleansing routine.”",
      brief,
    ),
    [],
  );
});

test("natural English child/female/male voices count as an English declaration", () => {
  for (const voice of ["童声", "童音", "女声", "男声", "儿童声线"]) {
    assert.deepEqual(inspectDefaultEnglishSpokenLanguage(`使用自然英语${voice}。孩子说：“Try this gentle wash.”`, "做一条产品短片"), []);
  }
  assert.deepEqual(inspectDefaultEnglishSpokenLanguage('全片对白均为英语；不生成中文口播、双语对白或字幕。孩子用英语说：“Try this gentle wash.”', "产品短片"), []);
  assert.deepEqual(inspectDefaultEnglishSpokenLanguage('英语童声，禁止使用中文配音。孩子说：“Try this.”', "产品短片"), []);
  assert.ok(inspectDefaultEnglishSpokenLanguage('英语童声，但后半段使用中文口播。孩子说：“Try this.”', "产品短片").length > 0);
});

test("spoken budget counts quoted voice-over once and excludes printed labels", () => {
  const speech = "Try this gentle wash for fresh clean skin every day.";
  const count = speech.match(/[A-Za-z]+/g).length;
  assert.equal(inspectShortViralPromptComplexity(`英语口播：“${speech}”`, 15).spokenLatinWords, count);
  const prompt = `包装可读文字包括“Salicylic Acid Body Wash 2%”和“Storetwo”。\n0–15秒：孩子用英语说：“${speech}”`;
  assert.equal(inspectShortViralPromptComplexity(prompt, 15).spokenLatinWords, count);
  assert.equal(inspectShortViralPromptComplexity(`指着标签，孩子说：“${speech}”`, 15).spokenLatinWords, count);
  assert.equal(inspectShortViralPromptComplexity(`英语旁白：${speech}`, 15).spokenLatinWords, count);
});

test("an explicit spoken-language request overrides English without confusing packaging text", () => {
  assert.equal(
    explicitSpokenLanguageFromBrief("产品包装上的文字是中文，请制作一个无口播广告。"),
    null,
  );
  assert.equal(
    explicitSpokenLanguageFromBrief("产品标签是英文，口播请使用西班牙语。"),
    "西班牙语",
  );
  assert.deepEqual(
    inspectDefaultEnglishSpokenLanguage(
      "全片使用中文口播。人物说：“先按一下泵头。”",
      "口播使用中文。",
    ),
    [],
  );
  assert.deepEqual(
    inspectDefaultEnglishSpokenLanguage(
      "制作15秒产品短片，无口播，只保留水声和泵头声。",
      "制作一个无声产品展示。",
    ),
    [],
  );
});

test("a missing continuity sentence is repaired locally instead of failing the task", () => {
  const draft =
    "0–3秒：平视中景建立三人误会。3–8秒：切到近景，人物拿出产品并使用。8–15秒：产品特写收尾。";
  assert.ok(
    inspectPromptCinematography(draft).includes(
      "正式提示词缺少单镜头路径或多镜头连续性策略",
    ),
  );
  const repaired = ensurePromptContinuityStrategy(draft);
  assert.deepEqual(inspectPromptCinematography(repaired), []);
  assert.match(repaired, /动作接点/);
  assert.match(repaired, /产品位置连续/);
  assert.equal(ensurePromptContinuityStrategy(repaired), repaired);
});

test("an existing concrete continuity rule is not followed by a generic duplicate", () => {
  const prompt =
    "0–4秒：她从画面右侧拿起产品并按下泵头。4–10秒：在按压动作接点切到手部特写，保持轴线、右手运动方向与产品位置连续。10–15秒：泵瓶留在同一右前方收尾。";
  assert.equal(ensurePromptContinuityStrategy(prompt), prompt);
  assert.doesNotMatch(ensurePromptContinuityStrategy(prompt), /镜头连续性：/);
});

const IMAGE_PROMPT_PATTERN =
  /(?:生图|图片生成|身份锚点|场景锚点|表情故事板|分镜图|参考图提示词|image\s*(?:generation|prompt)|storyboard\s*image)/i;
const VIDEO_PROMPT_PATTERN =
  /(?:seedance|视频|成片|导演提示词|直接粘贴|第\s*[一二三四五六七八九十\d]+\s*段|segment)/i;

function visibleSeedancePrompts(prompts) {
  return prompts.filter((prompt) => {
    const label = `${prompt.title} ${prompt.purpose}`;
    return (
      !IMAGE_PROMPT_PATTERN.test(label) &&
      VIDEO_PROMPT_PATTERN.test(label) &&
      prompt.content.trim()
    );
  });
}

test("old image-generation prompts are not shown as Seedance prompts", () => {
  const visible = visibleSeedancePrompts([
    {
      title: "原创15秒结构分镜图提示词",
      purpose: "图片生成",
      content: "生成一张六格分镜图",
    },
    {
      title: "Seedance 直接粘贴版",
      purpose: "最终视频提示词",
      content: "15秒广告视频",
    },
  ]);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].title, "Seedance 直接粘贴版");
});

test("common product wording and hidden workflow language are classified safely", () => {
  assert.equal(
    briefClaimsUploadedProductReference("这是我们的产品，请用它做广告"),
    true,
  );
  assert.equal(
    briefClaimsUploadedProductReference("附件里的就是我司产品包装"),
    true,
  );
  assert.equal(
    containsInternalWorkflowLanguage("Final pronunciation depends on reviewer approval."),
    true,
  );
  assert.equal(
    containsInternalWorkflowLanguage("系统稍后自动处理素材。"),
    true,
  );
  assert.equal(
    containsInternalWorkflowLanguage("同事确认后再生成。"),
    true,
  );
  assert.equal(
    containsInternalWorkflowLanguage("Upload @image1 first, then paste this prompt."),
    true,
  );
});

test("a named product followed by a numbered reference image is product truth", () => {
  const brief =
    "为这款沐浴露 【参考图片1】策划一个科普类动画视频，这款产品含2%水杨酸，有果酸、茶树和薄荷成分，明确用户痛点和收益";
  assert.equal(briefClaimsUploadedProductReference(brief), true);
  assert.equal(briefRequestsProductScienceAnimation(brief), true);
  assert.equal(
    briefClaimsUploadedProductReference(
      "请让参考图片1中的人物拿起一瓶未指定品牌的沐浴露。",
    ),
    false,
  );
});

test("a continuous product-science animation hook passes without shock wording", () => {
  const firstAnchor =
    "0–3秒：镜头放大粗糙的上臂皮肤，角质碎片和油脂颗粒堆积在皮肤纹理之间，形成拥堵的微型道路。";
  const plan = {
    hook: {
      timeRange: "0–3秒",
      visibleEvent:
        "镜头放大粗糙的上臂皮肤，角质碎片和油脂颗粒堆积在皮肤纹理之间，形成拥堵的微型道路",
      curiosityGap: "这些表面堆积会怎样在一次清洁中被带走",
      payoffTimeRange: "10–15秒",
      promptAnchor: firstAnchor,
    },
    storyBeats: [
      {
        order: 1,
        timeRange: "0–3秒",
        visibleEvent:
          "镜头放大粗糙的上臂皮肤，角质碎片和油脂颗粒堆积在皮肤纹理之间，形成拥堵的微型道路",
        narrativeFunction: "把洗后仍粗糙的痛点变成可读钩子",
        causedBy: "粗糙皮肤表面的油脂和松散角质形成可见堆积",
        productRole: "先建立需要清洁的表面问题",
        promptAnchor: firstAnchor,
      },
      {
        order: 2,
        timeRange: "3–10秒",
        visibleEvent:
          "泵瓶按压出泡沫，泡沫沿同一条微型道路铺开并让堆积颗粒松动散开",
        narrativeFunction: "让产品进入同一空间完成清洁动作",
        causedBy: "开场道路已被表面颗粒堵住并需要一次清洁",
        productRole: "产品泡沫覆盖表面堆积并使其松动",
        promptAnchor:
          "3–10秒：泵瓶按压出泡沫，泡沫沿同一条微型道路铺开并让堆积颗粒松动散开。",
      },
      {
        order: 3,
        timeRange: "10–15秒",
        visibleEvent:
          "清水冲走泡沫和已松动的表面颗粒，动画道路折叠回保留自然纹理的干净皮肤",
        narrativeFunction: "偿还痛点并回到真实产品收益",
        causedBy: "泡沫已经让同一处表面堆积松动并等待冲洗",
        productRole: "冲洗后的清爽平滑肤感完成产品收益证明",
        promptAnchor:
          "10–15秒：清水冲走泡沫和已松动的表面颗粒，动画道路折叠回保留自然纹理的干净皮肤。",
      },
    ],
    mechanismMappings: [],
    replicationLocks: [],
  };
  assert.deepEqual(
    inspectPromptQualityPlan(plan, {
      mode: "free",
      durationSeconds: 15,
      viralCore: [],
      promptContent: "",
      requirePromptAnchors: false,
    }),
    [],
  );
});

test("explicit person-reference wording enables the text identity contract", () => {
  assert.equal(
    briefClaimsUploadedCharacterReference(
      "参考图片2是我的人物参考图，纯文字提示词也要保持她的长相。",
    ),
    true,
  );
  assert.equal(
    briefClaimsUploadedCharacterReference("把这张图片里的人换成广告主角。"),
    true,
  );
  assert.equal(
    briefClaimsUploadedCharacterReference("图片1是我们的真实产品包装。"),
    false,
  );
});

test("text-only character identity needs facial geometry and anti-drift details", () => {
  const generic =
    "人物身份锁定：一名年轻漂亮的暖肤色长卷发女性，身材很好，穿黑色上衣。全片保持同一人物。";
  assert.match(
    inspectCharacterIdentityTextLock(generic).join("；"),
    /脸型与骨骼轮廓/,
  );

  const specific = `人物身份锁定：全片所有镜头始终是同一人物。成年女性，偏长鹅蛋脸，额头中等宽，颧骨柔和，下颌线收窄、圆钝下巴；平直浓眉、低眉峰，深棕杏眼，眼距略宽，清晰双眼皮；鼻梁笔直，鼻尖小而圆、鼻翼窄；上唇薄、下唇略厚，唇峰清楚、嘴角自然平直；可见肤色为暖调浅棕。深棕色长发从左侧分缝，发根蓬松，粗卷一直到胸口。肩线平直、骨架中等；黑色细肩带针织上衣，方领、哑光面料，小号金色圆耳环。禁止通用网红脸美化，禁止五官比例、脸型、年龄感、肤色、发型、体型、服装和配饰跨镜头改变或漂移。`;
  assert.deepEqual(inspectCharacterIdentityTextLock(specific), []);
});

test("only the final direct-paste Seedance prompt is selected", () => {
  const selected = selectFinalSeedancePrompt([
    {
      title: "Seedance导演完整版",
      purpose: "视频导演提示词",
      content: "长版提示词",
    },
    {
      title: "15秒直接粘贴版",
      purpose: "最终视频提示词",
      content: "最终提示词",
    },
  ]);
  assert.equal(selected?.title, "15秒直接粘贴版");
  assert.equal(selected?.content, "最终提示词");
});

test("a final video prompt is not hidden by a creative title", () => {
  const selected = selectFinalSeedancePrompt([
    {
      title: "角色身份锚点生图提示词",
      purpose: "图片生成",
      content: "生成角色参考图",
    },
    {
      title: "15秒海滩香水喜剧反转",
      purpose: "直接生成保留剧情功能和节奏包络的香水广告",
      content: "制作15秒写实海滩香水短片。",
    },
  ]);
  assert.equal(selected?.title, "15秒海滩香水喜剧反转");
  assert.equal(selected?.content, "制作15秒写实海滩香水短片。");
});

test("generatable missing concept assets are not blocking", () => {
  const assets = [
    { status: "missing", canGenerate: true, generationPrompt: "无品牌晶体切面手机" },
    { status: "missing", canGenerate: false, generationPrompt: "" },
  ];
  const blocking = assets.filter(
    (asset) => asset.status === "missing" && !asset.canGenerate,
  );
  assert.equal(blocking.length, 1);
  assert.equal(assets[0].generationPrompt.length > 0, true);
});

test("Seedance prompts reject workbench and human-confirmation language", () => {
  const leakedPrompt = `
@视频1是网页准备并由员工人工确认的去身份动作参考。
葡萄牙语台词草案为“Aí é muito fácil”；最终发音和文本需人工校对。
该说话者分配以处理版视频人工确认结果为准。
`;
  assert.equal(containsInternalWorkflowLanguage(leakedPrompt), true);
  assert.equal(
    containsInternalWorkflowLanguage("Pending manual review in the web app."),
    true,
  );
});

test("executable Seedance-only wording remains valid", () => {
  const cleanPrompt = `
@视频1只负责动作顺序、身体轨迹、相对位置、运镜和节奏，不参考脸、身份、肤色、发型或服装。
@视频1中的脸部遮挡仅为隐私覆盖，成片不得复制黑块、椭圆、马赛克或面罩，必须依据@图片1完整生成角色脸。
4.00–6.66秒由角色A说“Vinte mais vinte mais vinte mais sete”；9.80–12.70秒由角色B重复同一句台词。
  `;
  assert.equal(containsInternalWorkflowLanguage(cleanPrompt), false);
  assert.equal(
    containsInternalWorkflowLanguage("目标用户需要一台轻便、耐用的手机。"),
    false,
  );
});

test("explicitly uploaded real-product images trigger fidelity requirements", () => {
  assert.equal(
    briefClaimsUploadedProductReference(
      "图片1是我们公司的产品图，请结合参考视频做一条广告。",
    ),
    true,
  );
  assert.equal(
    briefClaimsUploadedProductReference("做一条原创钻石手机广告。"),
    false,
  );
  assert.equal(
    isProductIdentityResponsibility("真实产品外观与包装锚点"),
    true,
  );
});

test("real-product prompts must lock shape, text and anti-drift details", () => {
  const strongPrompt = `
@图片2是唯一真实产品外观与包装基准。全片严格保持原图中的产品轮廓、比例、结构、部件布局、配色、材质观感、包装、Logo位置和全部可见文字一致，始终是同一款产品。
不得改款、改色、增删部件、包装变形、Logo漂移，不得出现错字、乱码、镜像字、反转文字、替换文字或新增标签。
`;
  assert.equal(hasStrongProductFidelityLanguage(strongPrompt, "@图片2"), true);
  assert.equal(
    hasStrongProductFidelityLanguage("@图片2参考产品，保持好看。", "@图片2"),
    false,
  );
});

test("validated product references receive a deterministic final fidelity lock", () => {
  const draft = `@图片1只负责产品外观；不参考人物动作。\n0–3秒：人物拿起产品。`;
  const repaired = ensureStrongProductFidelityLanguage(draft, ["@图片1"]);
  assert.equal(hasStrongProductFidelityLanguage(repaired, "@图片1"), true);
  assert.match(repaired, /禁止改款/);
  assert.equal(ensureStrongProductFidelityLanguage(repaired, ["@图片1"]), repaired);
});

test("casual product photos may produce only source-faithful clean anchors", () => {
  const safeGenerationPrompt = `
依据附加的真实产品原图生成一张干净中性背景的单产品棚拍展示图。
严格保持参考图中的产品轮廓、比例、结构、部件布局、配色、包装与Logo位置。
不得发明原图不可见的部件、文字、Logo、标签或包装，不得重设计、改款或改色。
`;
  assert.equal(
    hasSafeCleanProductGenerationLanguage(safeGenerationPrompt),
    true,
  );
  assert.equal(
    hasSafeCleanProductGenerationLanguage("把这个产品重新设计得更高级。"),
    false,
  );
});

test("15-second viral prompts allow a compact six-beat story but reject excessive spoken copy", () => {
  const overloaded = `
0–0.8秒：动画。0.8–2.5秒：人物。2.5–4.2秒：产品。4.2–7.8秒：起泡。
7.8–10.5秒：冲洗。10.5–15秒：收尾。
女声：“This is an intentionally overlong spoken explanation that asks the model to fit far too many English words into a very short advertisement while also performing six different visual beats, explaining every product detail, repeating the complete routine, adding a second conclusion, and asking viewers to remember several separate messages at once.”
`;
  const result = inspectShortViralPromptComplexity(overloaded, 15);
  assert.equal(result.timelineBeats, 6);
  assert.equal(result.issues.length, 1);
  assert.ok(result.issues[0].includes("口播"));

  const overCut = `
0–1秒：特写。1–2秒：人物。2–4秒：问题。4–6秒：产品。6–8秒：起泡。8–10秒：冲洗。10–12秒：反应。12–15秒：收尾。`;
  assert.equal(inspectShortViralPromptComplexity(overCut, 15).timelineBeats, 8);
  assert.deepEqual(inspectShortViralPromptComplexity(overCut, 15).issues, []);

  const reinforced = `0–3秒：异常细节。3–8秒：真人演示。8–12秒：冲洗。12–15秒：产品收尾。
硬性规则：0–3秒不能改成空镜；3–8秒必须看见手与泡沫。`;
  assert.equal(inspectShortViralPromptComplexity(reinforced, 15).timelineBeats, 4);

  const focused = `
0–3.2秒：动画钩子。3.2–6.0秒：人物指出问题。6.0–11.5秒：泵取并起泡。
11.5–15秒：手持产品收尾。女声：“Rough skin? Here is my quick shower step: pump, lather, rinse, done.”
`;
  assert.deepEqual(inspectShortViralPromptComplexity(focused, 15).issues, []);
});

test("Seedance timing keeps useful phases and rejects invented stopwatch grids", () => {
  const focused = `
0–1秒：杯子突然从桌沿滑落，人物在落地前接住。
1–6秒：同一侧面中景继续，人物扣上防滑底座并把杯子放回原位。
6–11秒：手从同一方向再次推杯，固定机位看见杯子停住。
11–15秒：镜头推近杯底接触处，再回到人物举杯的稳定收尾。`;
  assert.deepEqual(inspectPromptTemporalClarity(focused, 15, "viral").issues, []);

  const stopwatch = `
0–1秒：特写杯子。1–2秒：切人物。2–3秒：切桌面。3–4秒：切产品。
4–5秒：切手部。5–6秒：切表情。6–7秒：切标签。7–8秒：切回人物。`;
  assert.match(
    inspectPromptTemporalClarity(stopwatch, 15, "viral").issues.join("；"),
    /时间段|一秒级碎切/,
  );

  const inventedPrecision =
    "0–0.35秒：人物抬眼。0.35–4.27秒：人物拿起产品。4.27–15秒：完成演示。";
  assert.match(
    inspectPromptTemporalClarity(inventedPrecision, 15, "free").issues.join("；"),
    /百分之一秒/,
  );

  assert.deepEqual(
    inspectPromptTemporalClarity(stopwatch, 15, "replication").issues,
    [],
  );
});

test("paste-ready prompts reject unresolved options but allow direct commands", () => {
  assert.match(
    inspectPromptExecutability("镜头可以考虑推近，也可以保持固定。最终视情况决定。").join("；"),
    /唯一、直接、可执行/,
  );
  assert.deepEqual(
    inspectPromptExecutability("固定眼高近景；人物按下泵头，镜头停在泡沫落入掌心的画面。"),
    [],
  );
});

test("paste-ready prompts exclude page controls and excessive short-video prose", () => {
  assert.match(
    inspectPromptPageOnlyControls(
      "生成15秒、9:16竖屏、1080×1920的写实产品短片。",
    ).join("；"),
    /分辨率或画幅/,
  );
  assert.deepEqual(
    inspectPromptPageOnlyControls("生成15秒写实产品短片。"),
    [],
  );
  assert.match(inspectPromptConcision("动作".repeat(1001), 15).join("；"), /2000字/);
  assert.deepEqual(inspectPromptConcision("动作".repeat(900), 15), []);

  const cleaned = stripPromptPageOnlyControls(
    "生成15秒、9:16竖屏、1080×1920、1080P的写实产品短片。",
  );
  assert.deepEqual(inspectPromptPageOnlyControls(cleaned), []);
  assert.doesNotMatch(cleaned, /9:16|1080/);
  assert.match(cleaned, /写实产品短片/);
});

test("only prompt-polish failures qualify for the last-resort handoff", () => {
  assert.equal(
    isNonBlockingFinalPromptQualityIssue(
      "正式提示词缺少单镜头路径或多镜头连续性策略",
    ),
    true,
  );
  assert.equal(
    isNonBlockingFinalPromptQualityIssue(
      "15秒正式提示词过长（2628字）；合并重复锁定和同义复述，压缩到2000字以内",
    ),
    true,
  );
  assert.equal(
    isNonBlockingFinalPromptQualityIssue(
      "正式提示词没有精确引用交付素材 @图片1",
    ),
    false,
  );
  assert.equal(
    isNonBlockingFinalPromptQualityIssue(
      "正式提示词仍含建议、备选方案或未决定项；改成唯一、直接、可执行的成片指令",
    ),
    false,
  );
  assert.equal(
    isNonBlockingFinalPromptQualityIssue("缺少复刻硬锁：action_order"),
    false,
  );
  assert.equal(
    isNonBlockingFinalPromptQualityIssue(
      "正式提示词没有围绕 @图片1 完整锁定真实产品",
    ),
    false,
  );
  assert.equal(
    isNonBlockingFinalPromptQualityIssue(
      "纯文字人物身份锁不够具体，缺少脸型与骨骼轮廓",
    ),
    true,
  );
  for (const recoverable of [
    "钩子不是可见的具体事件",
    "钩子缺少可执行提示词锚点",
    "第2条爆点迁移没有对应原理解",
    "第3条爆点迁移仍是空泛概念",
    "正式提示词遗漏第1个剧情节拍的时间段",
  ]) {
    assert.equal(isNonBlockingFinalPromptQualityIssue(recoverable), true, recoverable);
  }
  assert.equal(
    isNonBlockingFinalPromptQualityIssue(
      "创作路径偏离已确认方向：应为 ORIGINAL，实际为 REPAIR",
    ),
    false,
  );
  assert.equal(
    isNonBlockingUnderstandingQualityIssue("钩子不是可见的具体事件"),
    true,
  );
  assert.equal(
    isNonBlockingUnderstandingQualityIssue("剧情节拍没有覆盖成片首尾"),
    false,
  );
});

test("every delivered @ asset has an exact, bounded responsibility", () => {
  const bound =
    "@图片1只负责人物身份、服装和体型，不参考其中背景、动作或镜头。";
  assert.deepEqual(inspectPromptAssetBindings(bound, ["@图片1"]), []);
  assert.match(
    inspectPromptAssetBindings(
      "@图片10只负责人物身份，不参考背景。",
      ["@图片1"],
    ).join("；"),
    /没有精确引用/,
  );
  assert.match(
    inspectPromptAssetBindings("@图片1只负责人物身份。", ["@图片1"]).join(
      "；",
    ),
    /不能控制/,
  );
  assert.match(
    inspectPromptAssetBindings(
      "@视频1只负责动作节奏，不参考人物。\n@视频1只控制运镜，不参考产品。",
      ["@视频1"],
    ).join("；"),
    /重复声明/u,
  );
});

test("repeated asset duties collapse locally to one trusted block", () => {
  const bindings = [
    {
      reference: "@图片1",
      coreResponsibility: "真实产品外观与包装真值",
      doNotReference: "不参考人物、动作或场景",
    },
    {
      reference: "@视频1",
      coreResponsibility: "未被改写的机位、节奏与相对位置",
      doNotReference: "不参考原产品、人物身份或洗头接触路径",
    },
  ];
  const repeated = [
    "素材职责：",
    "@视频1只负责动作节奏，不参考人物。",
    "",
    "生成15秒洗肩短片。",
    "",
    "素材职责：@图片1只负责产品外观，不参考动作。@视频1只控制运镜，不参考原产品。",
    "0–5秒：人物把沐浴露泵到肩部。",
  ].join("\n");
  const repaired = consolidatePromptAssetBindings(repeated, bindings);
  assert.deepEqual(
    inspectPromptAssetBindings(repaired, ["@图片1", "@视频1"]),
    [],
  );
  assert.equal((repaired.match(/@图片1只负责/gu) ?? []).length, 1);
  assert.equal((repaired.match(/@视频1只负责/gu) ?? []).length, 1);
  assert.match(repaired, /生成15秒洗肩短片/u);
  assert.match(repaired, /人物把沐浴露泵到肩部/u);
});

test("English prompt translation preserves material bindings and timing", () => {
  const source =
    "@图片1只负责产品真实外观，不参考背景。0–3秒：人物拿起产品。3–15秒：@视频1只负责动作节奏，不参考人物身份。";
  const valid =
    "@图片1 controls only the product's real appearance; do not reference the background. 0 to 3 seconds: The performer picks up the product. 3–15s: @视频1 controls only action rhythm; do not reference the person's identity.";
  assert.deepEqual(inspectPromptTranslation(source, valid), []);
  assert.match(
    inspectPromptTranslation(source, valid.replace("@视频1", "@Video1")).join("；"),
    /编号/u,
  );
  assert.match(
    inspectPromptTranslation(source, valid.replace("3–15s", "4–15s")).join("；"),
    /时间段/u,
  );
  const spokenSource = `${source} 口播：“Keep the 2% label visible.”`;
  const spokenEnglish = `${valid} Voice-over: “Keep the 2% label visible.”`;
  assert.deepEqual(inspectPromptTranslation(spokenSource, spokenEnglish), []);
  assert.match(
    inspectPromptTranslation(
      spokenSource,
      spokenEnglish.replace("Keep the 2% label visible.", "Show the label."),
    ).join("；"),
    /英文台词/u,
  );
});

test("validated upload-plan bindings deterministically repair distant references", () => {
  const draft =
    "0–3秒：人物拿起@图片1中的产品。3–8秒：脚跟按@图片2的方式轻推产品。8–15秒：产品正面定格。";
  const bindings = [
    {
      reference: "@图片1",
      coreResponsibility: "产品真实外观、Logo位置与可见文字真值",
      doNotReference: "不参考背景花朵或尺寸标线",
    },
    {
      reference: "@图片2",
      coreResponsibility: "脚跟接触构图与细小落屑表现",
      doNotReference: "人物身份、背景或产品结构",
    },
  ];
  assert.notDeepEqual(inspectPromptAssetBindings(draft, ["@图片1", "@图片2"]), []);
  const repaired = ensurePromptAssetBindings(draft, bindings);
  assert.match(repaired, /^素材职责：\n@图片1只负责产品真实外观/u);
  assert.match(repaired, /@图片2只负责脚跟接触构图.*不参考人物身份/u);
  assert.deepEqual(
    inspectPromptAssetBindings(repaired, ["@图片1", "@图片2"]),
    [],
  );
  assert.equal(ensurePromptAssetBindings(repaired, bindings), repaired);
});

test("the same timed beat cannot be restated as a second paragraph", () => {
  const duplicated =
    "0–3秒：杯子突然滑落，人物伸手接住。0–3秒：开场用滑落的杯子形成钩子。3–9秒：人物扣上底座。9–15秒：再次推杯验证停稳。";
  assert.match(
    inspectPromptTemporalClarity(duplicated, 15, "viral").issues.join("；"),
    /同一时间段被重复/,
  );
});

test("viral quality contract requires a concrete hook, causal beats and one mapping per insight", () => {
  const viralCore = [
    "开场用异常剖面制造问题",
    "真人演示把抽象问题变成可见步骤",
  ];
  const anchors = [
    "0–2.5秒：皮肤剖面突然裂开，粗糙颗粒从纹理中弹出。",
    "2.5–6秒：人物拿起产品按压泵头，泡沫落入掌心。",
    "6–11秒：她在手臂揉出细密泡沫，再用清水冲净。",
    "11–15秒：镜头推近同一产品，人物触摸清洁后的手臂。",
  ];
  const plan = {
    hook: {
      timeRange: "0–2.5秒",
      visibleEvent: "皮肤剖面突然裂开，粗糙颗粒从纹理中弹出",
      curiosityGap: "这些颗粒如何在洗澡时被温和带走",
      payoffTimeRange: "11–15秒",
      promptAnchor: anchors[0],
    },
    storyBeats: anchors.map((promptAnchor, index) => ({
      order: index + 1,
      timeRange: ["0–2.5秒", "2.5–6秒", "6–11秒", "11–15秒"][index],
      visibleEvent: [
        "皮肤剖面突然裂开，粗糙颗粒从纹理中弹出",
        "人物拿起产品并按压泵头，泡沫落入掌心",
        "人物在手臂揉出细密泡沫，再用清水冲净",
        "镜头推近同一产品，人物触摸清洁后的手臂",
      ][index],
      narrativeFunction: ["停止滑动", "产品介入", "过程证明", "偿还并收尾"][index],
      causedBy:
        index === 0
          ? "首帧直接抛出尚未解释的皮肤表面异常"
          : [
              "粗糙颗粒出现后，需要让产品立即介入",
              "泵出的洗液必须通过起泡和冲洗证明使用过程",
              "冲洗完成后需要用同一区域和产品完成视觉偿还",
            ][index - 1],
      productRole: index === 0 ? "提出待解决问题" : "完成清洁步骤",
      promptAnchor,
    })),
    mechanismMappings: viralCore.map((sourceMechanism, index) => ({
      order: index + 1,
      sourceMechanism,
      targetTimeRange: index === 0 ? "0–2.5秒" : "6–11秒",
      targetVisibleEvent:
        index === 0
          ? "皮肤剖面突然裂开，粗糙颗粒从纹理中弹出"
          : "人物揉出泡沫并用清水冲净，展示完整步骤",
      productRole: index === 0 ? "提出清洁对象" : "完成过程证明",
      promptAnchor: index === 0 ? anchors[0] : anchors[2],
    })),
    replicationLocks: [],
  };
  assert.deepEqual(
    inspectPromptQualityPlan(plan, {
      mode: "viral",
      durationSeconds: 15,
      viralCore,
      promptContent:
        anchors.join("\n") +
        "\n摄影：从俯拍特写转为侧面中近景，镜头之间用动作匹配衔接，保持人物视线、右臂与产品位置连续。",
      requirePromptAnchors: true,
    }),
    [],
  );

  const staleAnchors = structuredClone(plan);
  staleAnchors.hook.promptAnchor = "高级感钩子";
  staleAnchors.mechanismMappings[1].promptAnchor = "";
  const rebound = repairPromptQualityAnchors(staleAnchors, [
    "钩子缺少可执行提示词锚点",
    "第2条爆点迁移缺少提示词锚点",
  ]);
  assert.equal(rebound.hook.promptAnchor, anchors[0]);
  assert.equal(rebound.mechanismMappings[1].promptAnchor, anchors[2]);
  assert.deepEqual(
    inspectPromptQualityPlan(rebound, {
      mode: "viral",
      durationSeconds: 15,
      viralCore,
      promptContent:
        anchors.join("\n") +
        "\n摄影：从俯拍特写转为侧面中近景，镜头之间用动作匹配衔接，保持人物视线、右臂与产品位置连续。",
      requirePromptAnchors: true,
    }),
    [],
  );

  const generic = structuredClone(plan);
  generic.hook.visibleEvent = "营造高级感并吸引注意";
  generic.storyBeats[0].visibleEvent = "展示产品的高级氛围";
  generic.mechanismMappings[0].targetVisibleEvent = "做一个高级的爆款钩子";
  assert.ok(
    inspectPromptQualityPlan(generic, {
      mode: "viral",
      durationSeconds: 15,
      viralCore,
      promptContent:
        anchors.join("\n") +
        "\n摄影：从俯拍特写转为侧面中近景，镜头之间用动作匹配衔接，保持人物视线、右臂与产品位置连续。",
      requirePromptAnchors: true,
    }).some((issue) => issue.includes("具体")),
  );

  const abstractCause = structuredClone(plan);
  abstractCause.storyBeats[1].causedBy = "为了推进剧情";
  assert.match(
    inspectPromptQualityPlan(abstractCause, {
      mode: "viral",
      durationSeconds: 15,
      viralCore,
      promptContent: "",
      requirePromptAnchors: false,
    }).join("；"),
    /因果职责/,
  );

  const gapped = structuredClone(plan);
  gapped.storyBeats[1].timeRange = "3–6秒";
  assert.match(
    inspectPromptQualityPlan(gapped, {
      mode: "viral",
      durationSeconds: 15,
      viralCore,
      promptContent: "",
      requirePromptAnchors: false,
    }).join("；"),
    /时间空档/,
  );

  const separateAnchor = structuredClone(plan);
  separateAnchor.hook.promptAnchor = "0–2.5秒：粗糙颗粒突然弹出并落到画面前景。";
  assert.match(
    inspectPromptQualityPlan(separateAnchor, {
      mode: "viral",
      durationSeconds: 15,
      viralCore,
      promptContent:
        anchors.join("\n") +
        "\n摄影：从俯拍特写转为侧面中近景，镜头之间用动作匹配衔接，保持人物视线、右臂与产品位置连续。",
      requirePromptAnchors: true,
    }).join("；"),
    /原文片段/,
  );

  const duplicated = structuredClone(plan);
  duplicated.mechanismMappings[1].targetVisibleEvent =
    duplicated.mechanismMappings[0].targetVisibleEvent;
  duplicated.mechanismMappings[1].promptAnchor =
    duplicated.mechanismMappings[0].promptAnchor;
  assert.ok(
    inspectPromptQualityPlan(duplicated, {
      mode: "viral",
      durationSeconds: 15,
      viralCore,
      promptContent:
        anchors.join("\n") +
        "\n摄影：从俯拍特写转为侧面中近景，镜头之间用动作匹配衔接，保持人物视线、右臂与产品位置连续。",
      requirePromptAnchors: true,
    }).some((issue) => issue.includes("重复套用")),
  );
});

test("a filmable state change passes while an aesthetic slogan stays rejected", () => {
  const base = {
    hook: {
      timeRange: "0–2秒",
      visibleEvent: "人物按下泵头，白色泡沫在掌心堆起并遮住一半指节",
      curiosityGap: "这团泡沫会怎样改变后续展示",
      payoffTimeRange: "10–15秒",
      promptAnchor: "人物按下泵头，白色泡沫在掌心堆起并遮住一半指节",
    },
    storyBeats: [
      {
        order: 1,
        timeRange: "0–4秒",
        visibleEvent: "人物按下泵头，白色泡沫在掌心堆起并遮住一半指节",
        narrativeFunction: "制造异常钩子",
        causedBy: "开场空手掌与泵头形成明确操作关系",
        productRole: "泵头真实出液并形成可见泡沫",
        promptAnchor: "0–4秒：人物按下泵头，白色泡沫在掌心堆起并遮住一半指节",
      },
      {
        order: 2,
        timeRange: "4–10秒",
        visibleEvent: "泡沫从右臂上方铺到肘部，湿润区域由透明变成白色",
        narrativeFunction: "展示使用过程",
        causedBy: "掌心已经形成足量泡沫并贴上手臂",
        productRole: "泡沫覆盖路径证明产品可被均匀揉开",
        promptAnchor: "4–10秒：泡沫从右臂上方铺到肘部，湿润区域由透明变成白色",
      },
      {
        order: 3,
        timeRange: "10–15秒",
        visibleEvent: "清水从肩部冲到肘部，白色泡沫消失并露出湿润皮肤",
        narrativeFunction: "偿还开场问题",
        causedBy: "手臂已经被白色泡沫完整覆盖",
        productRole: "冲洗后没有残留泡沫并完成清洁演示",
        promptAnchor: "10–15秒：清水从肩部冲到肘部，白色泡沫消失并露出湿润皮肤",
      },
    ],
    mechanismMappings: [
      {
        order: 1,
        sourceMechanism: "异常首帧引发疑问",
        targetTimeRange: "0–2秒",
        targetVisibleEvent: "人物按下泵头，白色泡沫在掌心堆起并遮住一半指节",
        productRole: "泵头真实出液并形成可见泡沫",
        promptAnchor: "人物按下泵头，白色泡沫在掌心堆起并遮住一半指节",
      },
    ],
    replicationLocks: [],
  };
  const prompt =
    base.storyBeats.map((beat) => beat.promptAnchor).join("。") +
    "。摄影保持侧面中近景固定机位，三段动作连续衔接，人物右臂与泵瓶位置连续。";
  assert.deepEqual(
    inspectPromptQualityPlan(base, {
      mode: "viral",
      durationSeconds: 15,
      viralCore: ["异常首帧引发疑问"],
      promptContent: prompt,
      requirePromptAnchors: true,
    }),
    [],
  );

  const vague = structuredClone(base);
  vague.mechanismMappings[0].targetVisibleEvent = "营造高级氛围并突出产品质感";
  assert.match(
    inspectPromptQualityPlan(vague, {
      mode: "viral",
      durationSeconds: 15,
      viralCore: ["异常首帧引发疑问"],
      promptContent: prompt,
      requirePromptAnchors: true,
    }).join("；"),
    /空泛概念/,
  );
});

test("camera language gate requires executable framing, continuity and concise wording", () => {
  assert.deepEqual(
    inspectPromptCinematography(
      "正面眼高固定中景不切镜；人物从画面右前方后退，镜头保持双人同框并停在产品正面可见的位置。",
    ),
    [],
  );
  assert.match(
    inspectPromptCinematography("电影感镜头展示人物和产品。继续下一个画面。").join("；"),
    /可执行.*连续性/,
  );
  assert.match(
    inspectPromptCinematography(
      "固定机位不切镜，高级感、电影感、大片感、氛围感、视觉冲击全部拉满。",
    ).join("；"),
    /形容词/,
  );
});

test("replication quality contract requires all eight observable hard locks", () => {
  const beatAnchors = [
    "0–4秒：角色A贴近镜头抬手指向镜头。",
    "4–10秒：角色A后退，角色B从左后方进入并插话。",
    "10–15秒：两人保持左右站位，角色B抬手完成结尾反应。",
  ];
  const lockNames = [
    "action_order",
    "relative_position",
    "camera_position",
    "camera_motion",
    "pacing",
    "gesture_contact",
    "sound_cue",
    "end_state",
  ];
  const lockInstructions = {
    action_order: "先由角色A贴近镜头发问，再让角色B从左后方进入，最后双人回应",
    relative_position: "角色A始终在右前方，角色B从左后方进入并停在画面左侧",
    camera_position: "正面眼睛高度手机机位，开场脸部近景，随后容纳双人中景",
    camera_motion: "保持固定机位，不推拉、不摇移、不切镜，只保留轻微手持微动",
    pacing: "前三秒完成发问，4秒进入双人段，10秒后进入结尾回应",
    gesture_contact: "角色A先用手指指向镜头，随后摊掌；两人之间不发生身体接触",
    sound_cue: "短问句结束后停顿半秒，角色B入场台词与抬手动作落在同一重拍",
    end_state: "尾帧保持角色B在左侧抬手、角色A在右侧转头看向它的双人同框",
  };
  const lockAnchors = lockNames.map(
    (name) => `复刻硬锁：${lockInstructions[name]}`,
  );
  const plan = {
    hook: {
      timeRange: "0–3秒",
      visibleEvent: "角色A贴近镜头抬手指向镜头并说出短句",
      curiosityGap: "角色B会如何回应这句挑衅",
      payoffTimeRange: "10–15秒",
      promptAnchor: beatAnchors[0],
    },
    storyBeats: beatAnchors.map((promptAnchor, index) => ({
      order: index + 1,
      timeRange: ["0–4秒", "4–10秒", "10–15秒"][index],
      visibleEvent: [
        "角色A贴近镜头抬手指向镜头",
        "角色A后退，角色B从左后方进入并插话",
        "两人保持左右站位，角色B抬手完成结尾反应",
      ][index],
      narrativeFunction: ["开场挑战", "关系升级", "反应偿还"][index],
      causedBy:
        index === 0
          ? "主角色直接贴近镜头抛出挑衅式短问句"
          : "前一拍的问句或回答触发下一位角色入场回应",
      productRole: "不适用",
      promptAnchor,
    })),
    mechanismMappings: [],
    replicationLocks: lockNames.map((lockType, index) => ({
      lockType,
      sourceTimeRange: "0–15秒",
      targetTimeRange: "0–15秒",
      instruction: lockInstructions[lockType],
      promptAnchor: lockAnchors[index],
    })),
  };
  assert.deepEqual(
    inspectPromptQualityPlan(plan, {
      mode: "replication",
      durationSeconds: 15,
      viralCore: ["动作和镜头顺序"],
      promptContent: [...beatAnchors, ...lockAnchors].join("\n"),
      requirePromptAnchors: true,
    }),
    [],
  );

  plan.replicationLocks.pop();
  assert.ok(
    inspectPromptQualityPlan(plan, {
      mode: "replication",
      durationSeconds: 15,
      viralCore: ["动作和镜头顺序"],
      promptContent: [...beatAnchors, ...lockAnchors].join("\n"),
      requirePromptAnchors: true,
    }).some((issue) => issue.includes("end_state")),
  );

  const genericLocks = structuredClone(plan);
  genericLocks.replicationLocks = lockNames.map((lockType) => ({
    lockType,
    sourceTimeRange: "0–15秒",
    targetTimeRange: "0–15秒",
    instruction: "strictly follow source video and stay consistent",
    promptAnchor: "strictly follow source video and stay consistent",
  }));
  assert.ok(
    inspectPromptQualityPlan(genericLocks, {
      mode: "replication",
      durationSeconds: 15,
      viralCore: ["动作和镜头顺序"],
      promptContent: "strictly follow source video and stay consistent",
      requirePromptAnchors: true,
    }).some((issue) => issue.includes("缺少可执行指令")),
  );

  const oneMegaLock = structuredClone(plan);
  const megaClause =
    "先由角色A右手指向镜头，然后角色B从左后方入画；正面眼高固定中景不切镜；4秒后停顿半秒再说台词，声音与抬手同步；尾帧保持A在右、B在左同框";
  oneMegaLock.replicationLocks = lockNames.map((lockType) => ({
    lockType,
    sourceTimeRange: "0–15秒",
    targetTimeRange: "0–15秒",
    instruction: megaClause,
    promptAnchor: megaClause,
  }));
  assert.match(
    inspectPromptQualityPlan(oneMegaLock, {
      mode: "replication",
      durationSeconds: 15,
      viralCore: ["动作和镜头顺序"],
      promptContent: megaClause,
      requirePromptAnchors: true,
    }).join("；"),
    /八类不得共用同一句话/,
  );

  const vagueCameraLock = structuredClone(plan);
  vagueCameraLock.replicationLocks.find(
    (lock) => lock.lockType === "camera_position",
  ).instruction = "机位按原片保持一致";
  assert.match(
    inspectPromptQualityPlan(vagueCameraLock, {
      mode: "replication",
      durationSeconds: 15,
      viralCore: ["动作和镜头顺序"],
      promptContent: [...beatAnchors, ...lockAnchors].join("\n"),
      requirePromptAnchors: true,
    }).join("；"),
    /camera_position 缺少可执行指令/,
  );
});

test("content imitation keeps recognizable story functions without pretending to be frame-exact", () => {
  const viralCore = [
    "角色A递出空盒，角色B先质疑",
    "角色B打开盒子看到目标物后立刻反转",
  ];
  const anchors = [
    "0–3秒：角色A从画面右侧递出一个合上的空盒，角色B在左侧皱眉后退半步。",
    "3–9秒：角色B接过盒子并向上掀开盒盖，盒内目标物亮起，角色B立刻靠近查看。",
    "9–15秒：角色B把盒子转向镜头并点头，角色A保持右侧站位伸手接住盒盖。",
  ];
  const plan = {
    hook: {
      timeRange: "0–3秒",
      visibleEvent: "角色A从右侧递出合上的空盒，角色B皱眉后退半步",
      curiosityGap: "盒子打开后为什么会让质疑者改变态度",
      payoffTimeRange: "9–15秒",
      promptAnchor: anchors[0],
    },
    storyBeats: anchors.map((promptAnchor, index) => ({
      order: index + 1,
      timeRange: ["0–3秒", "3–9秒", "9–15秒"][index],
      visibleEvent: [
        "角色A从右侧递出合上的空盒，角色B皱眉后退半步",
        "角色B掀开盒盖并靠近查看盒内亮起的目标物",
        "角色B把盒子转向镜头并点头，角色A伸手接住盒盖",
      ][index],
      narrativeFunction: ["建立质疑", "揭开信息", "态度反转并收尾"][index],
      causedBy: [
        "角色A突然递出一个没有说明用途的合上盒子",
        "角色B对合上的盒子产生质疑并决定亲手打开",
        "盒内目标物亮起并让角色B看清此前不知道的信息",
      ][index],
      productRole: "不适用",
      promptAnchor,
    })),
    mechanismMappings: viralCore.map((sourceMechanism, index) => ({
      order: index + 1,
      sourceMechanism,
      targetTimeRange: index === 0 ? "0–3秒" : "3–9秒",
      targetVisibleEvent:
        index === 0
          ? "角色A递出合上的盒子，角色B皱眉后退"
          : "角色B掀开盒盖后靠近查看并立刻点头",
      productRole: "不适用",
      promptAnchor: index === 0 ? anchors[0] : anchors[1],
    })),
    replicationLocks: [],
  };
  const prompt = `${anchors.join("\n")}\n摄影：正面眼高固定中景，开盒动作中切到近景，保持角色A在屏幕右侧、角色B在左侧，盒子与接盒手位连续。`;
  assert.deepEqual(
    inspectPromptQualityPlan(plan, {
      mode: "imitation",
      durationSeconds: 15,
      viralCore,
      promptContent: prompt,
      requirePromptAnchors: true,
    }),
    [],
  );
});

test("original and repair routes cannot hide fake source mappings or replication locks", () => {
  const anchors = [
    "0–3秒：透明杯从桌边滑落，人物伸手在杯口碰到地面前接住。",
    "3–10秒：人物把杯子放回桌面并扣上防滑底座，杯身停止晃动。",
    "10–15秒：人物再次推杯，杯子停在原位，镜头停在底座与桌面的接触处。",
  ];
  const plan = {
    hook: {
      timeRange: "0–3秒",
      visibleEvent: "透明杯从桌边滑落，人物伸手在落地前接住",
      curiosityGap: "杯子怎样才能在同一桌边不再滑落",
      payoffTimeRange: "10–15秒",
      promptAnchor: anchors[0],
    },
    storyBeats: anchors.map((promptAnchor, index) => ({
      order: index + 1,
      timeRange: ["0–3秒", "3–10秒", "10–15秒"][index],
      visibleEvent: [
        "透明杯从桌边滑落，人物伸手在落地前接住",
        "人物把杯子放回桌面并扣上防滑底座，杯身停止晃动",
        "人物再次推杯，杯子停在原位，镜头停在底座接触处",
      ][index],
      narrativeFunction: ["抛出危险", "解决原因", "可见验证"][index],
      causedBy: [
        "杯底在光滑桌面失去摩擦并越过桌边",
        "杯子差点落地后需要增加稳定接触",
        "防滑底座扣紧后需要用同样推力验证结果",
      ][index],
      productRole: index === 0 ? "提出问题" : "防滑底座改变杯子与桌面的接触状态",
      promptAnchor,
    })),
    mechanismMappings: [],
    replicationLocks: [],
  };
  const prompt = `${anchors.join("\n")}\n摄影：侧面桌高固定中景，接杯动作中推近底座特写，保持杯子从屏幕右向左的运动方向和人物手位连续。`;
  assert.deepEqual(
    inspectPromptQualityPlan(plan, {
      mode: "free",
      durationSeconds: 15,
      viralCore: [],
      promptContent: prompt,
      requirePromptAnchors: true,
    }),
    [],
  );
  plan.mechanismMappings.push({
    order: 1,
    sourceMechanism: "伪造参考机制",
    targetTimeRange: "0–3秒",
    targetVisibleEvent: "透明杯从桌边滑落",
    productRole: "提出问题",
    promptAnchor: anchors[0],
  });
  assert.match(
    inspectPromptQualityPlan(plan, {
      mode: "free",
      durationSeconds: 15,
      viralCore: [],
      promptContent: prompt,
      requirePromptAnchors: true,
    }).join("；"),
    /不应伪造参考片机制映射/,
  );
});

test("unquoted English voice-over still counts toward the duration budget", () => {
  const prompt =
    "0.0–3.0 s：异常细节。3.0–9.0 s：人物演示。9.0–15.0 s：产品收尾。\n" +
    "画外音：This intentionally long unquoted voice over keeps adding more and more words until it clearly exceeds the physical speaking budget for a fifteen second advertising video, repeats the full routine, explains every ingredient, adds several benefits, gives another conclusion, and asks the viewer to remember multiple separate calls to action before the final frame appears.";
  const result = inspectShortViralPromptComplexity(prompt, 15);
  assert.equal(result.timelineBeats, 3);
  assert.ok(result.spokenLatinWords > 20);
  assert.equal(result.issues.length, 1);
});

test("expression time ranges accept numeric-equivalent prompt formatting", () => {
  assert.equal(
    promptContainsTimeRange("0.00–1.00 秒：人物立即抬眉看向镜头。", "0–1秒"),
    true,
  );
  assert.equal(
    promptContainsTimeRange("1–2秒：人物微笑。", "0–1秒"),
    false,
  );
});

test("timeline parsing accepts common model formatting without rejecting a valid plan", () => {
  assert.deepEqual(parsePromptTimeRange("0s–2s"), { start: 0, end: 2 });
  assert.deepEqual(parsePromptTimeRange("0秒-2秒"), { start: 0, end: 2 });
  assert.deepEqual(parsePromptTimeRange("00:01–00:03.5"), { start: 1, end: 3.5 });
  assert.deepEqual(parsePromptTimeRange("0–2"), { start: 0, end: 2 });
  assert.equal(
    promptContainsTimeRange("0s–2s：产品从手中滑落，人物立即伸手接住。", "0–2秒"),
    true,
  );
});

test("reference-led understanding always exposes keep change and do-not-copy decisions", () => {
  const viral = ensureReferenceDecisionFramework(
    "把原人物换成产品使用者，并把原事件改为产品演示。",
    ["开场用一次可见失误制造悬念", "结尾用同条件复测偿还悬念"],
    "VIRAL_ADAPTATION",
  );
  assert.match(viral, /^保留：/u);
  assert.match(viral, /\n改成：/u);
  assert.match(viral, /\n不照搬：/u);
  assert.match(viral, /具体动作顺序和独特镜头组合/u);

  const replication = ensureReferenceDecisionFramework(
    "只把原人物和产品替换成用户指定版本。",
    ["保留原片逐段动作、机位与节奏"],
    "STRICT_REPLICATION",
  );
  assert.match(replication, /动作顺序、人物相对位置、机位、运镜、节奏/u);
  assert.match(replication, /不在忽略范围内/u);

  const complete =
    "保留：原片的三段反转节奏。\n改成：用户产品的三次验证。\n不照搬：原人物、台词和动作。";
  assert.equal(
    ensureReferenceDecisionFramework(complete, [], "VIRAL_ADAPTATION"),
    complete,
  );
});
