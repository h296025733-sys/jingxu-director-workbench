import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedProvidedAssetKeysForDelivery,
  buildInputReferenceManifest,
  buildDirectorOutputSchemaForAssets,
  briefRequiresVerbatimSpokenCopy,
  hasAbsolutePath,
  inspectDirectorAssetPlanKeyConsistency,
  inspectFaceAllowedCharacterAnchorPlan,
  inspectFinalPromptInputReferenceLeak,
  inspectRestrictedAssetPlanRepairDrift,
  inspectTextOnlyProductIdentityLock,
  isRecoverableAssetPlanIssue,
  normalizeDirectorAssetStatusMetadata,
  redactAbsolutePaths,
  repairFaceAllowedCharacterAnchorPlan,
  requiresReferenceVideoCarrier,
  restoreConfirmedDirectorDirection,
  uploadPlanItemHasPersonSubjectResponsibility,
} from "../lib/codex-director.ts";

const INPUT_ASSETS = [
  {
    key: "REFERENCE_IMAGES_1",
    id: "asset-1",
    fieldKey: "referenceImages",
    name: "product.png",
    path: "unused-in-pure-test.png",
    mimeType: "image/png",
  },
];

test("ordinary supplied copy may fit duration but explicitly verbatim speech remains locked", () => {
  assert.equal(briefRequiresVerbatimSpokenCopy('台词为：“Here is my product.”'), false);
  assert.equal(briefRequiresVerbatimSpokenCopy("台词一字不改"), true);
  assert.equal(briefRequiresVerbatimSpokenCopy("请逐字保留口播"), true);
  assert.equal(briefRequiresVerbatimSpokenCopy("不要逐字照搬口播，可以适当压缩"), false);
  assert.equal(briefRequiresVerbatimSpokenCopy("Use the script verbatim"), true);
});

test("input evidence and final provided carriers stay separate in all modes", () => {
  const params = {
    hasReferenceVideo: true,
    inputReferenceLabels: '["\u53c2\u8003\u56fe\u72471"]',
  };
  assert.deepEqual(
    buildInputReferenceManifest(params, INPUT_ASSETS).map(
      ({ inputLabel, assetKey, type }) => ({ inputLabel, assetKey, type }),
    ),
    [
      { inputLabel: "参考视频1", assetKey: "REFERENCE_VIDEO", type: "video" },
      { inputLabel: "参考图片1", assetKey: "REFERENCE_IMAGES_1", type: "image" },
    ],
  );
  assert.deepEqual(
    allowedProvidedAssetKeysForDelivery("text_only", params, INPUT_ASSETS),
    [],
  );
  assert.deepEqual(
    allowedProvidedAssetKeysForDelivery("images_text", params, INPUT_ASSETS),
    ["REFERENCE_IMAGES_1"],
  );
  assert.deepEqual(
    allowedProvidedAssetKeysForDelivery(
      "video_images_text",
      params,
      INPUT_ASSETS,
    ),
    ["REFERENCE_VIDEO", "REFERENCE_IMAGES_1"],
  );
  assert.equal(
    requiresReferenceVideoCarrier({
      deliveryMode: "video_images_text",
      understandingOnly: false,
      hasReferenceVideo: true,
    }),
    true,
  );
  assert.equal(
    requiresReferenceVideoCarrier({
      deliveryMode: "video_images_text",
      understandingOnly: true,
      hasReferenceVideo: true,
    }),
    false,
  );
  assert.equal(
    requiresReferenceVideoCarrier({
      deliveryMode: "video_images_text",
      understandingOnly: true,
      hasReferenceVideo: true,
      forceReferenceVideoDelivery: true,
    }),
    false,
    "understanding must never be forced to emit a final video carrier",
  );
  assert.equal(
    requiresReferenceVideoCarrier({
      deliveryMode: "images_text",
      understandingOnly: false,
      hasReferenceVideo: true,
    }),
    false,
  );
  assert.equal(
    requiresReferenceVideoCarrier({
      deliveryMode: "video_images_text",
      understandingOnly: false,
      hasReferenceVideo: false,
    }),
    false,
  );
});

test("final prompts cannot leak input evidence labels", () => {
  assert.ok(
    inspectFinalPromptInputReferenceLeak(
      "参考图片1负责产品，参考视频 1 负责动作。",
    ).length > 0,
  );
  assert.deepEqual(
    inspectFinalPromptInputReferenceLeak(
      "@图片1只负责产品外观，@视频1只负责动作节奏。",
    ),
    [],
  );
  assert.deepEqual(
    inspectFinalPromptInputReferenceLeak(
      "产品身份锁定：白色圆柱泵瓶，全片轮廓与配色不变。",
    ),
    [],
  );
});

test("no-faces classification does not turn a product exclusion into a person image", () => {
  assert.equal(
    uploadPlanItemHasPersonSubjectResponsibility({
      displayName: "沐浴露产品正面图",
      coreResponsibility: "真实产品外观、包装、Logo和可见文字锚点",
      doNotReference: "不参考人物、动作、肩部皮肤或场景",
    }),
    false,
  );
  assert.equal(
    uploadPlanItemHasPersonSubjectResponsibility({
      displayName: "人物动作状态图",
      coreResponsibility: "人物体型、服装和洗肩动作锚点",
      doNotReference: "不参考产品包装",
    }),
    true,
  );
});

test("face-allowed image delivery requires an identity anchor for recurring body crops", () => {
  const recurringBodyDraft = {
    status: "ready",
    qualityPlan: {
      storyBeats: [
        {
          visibleEvent: "俯拍同一双腿，一只手停在右侧小腿",
          promptAnchor: "手停在小腿",
        },
        {
          visibleEvent: "双手揉搓同一小腿并把泡沫冲净",
          promptAnchor: "双手揉搓小腿",
        },
      ],
    },
    prompts: [
      {
        content: "人物与场景：一名成年模特，只展示同一双腿和双手。",
      },
    ],
    uploadPlan: [
      {
        type: "image",
        assetKey: "REFERENCE_IMAGES_1",
        displayName: "沐浴露产品图",
        coreResponsibility: "真实产品身份与包装锚点",
      },
    ],
    requiredAssets: [],
  };

  const issues = inspectFaceAllowedCharacterAnchorPlan(recurringBodyDraft, {
    deliveryMode: "images_text",
    understandingOnly: false,
    faceReferencePolicy: "faces_allowed",
    expectsUploadedCharacterReference: false,
  });
  assert.equal(issues.length, 1);
  assert.ok(isRecoverableAssetPlanIssue(issues[0]));
  assert.match(issues[0], /系统生成的原创露脸人物身份锚点/u);
});

test("face-allowed image delivery requires an identity anchor for one explicit person-led beat", () => {
  const onePersonBeatDraft = {
    status: "ready",
    qualityPlan: {
      storyBeats: [
        {
          visibleEvent: "一名成年男人站在浴室里拿起沐浴露并看向镜头",
          promptAnchor: "成年男人拿起沐浴露",
        },
      ],
    },
    prompts: [{ content: "一名成年男人拿起产品并完成演示。" }],
    uploadPlan: [
      {
        type: "image",
        assetKey: "REFERENCE_IMAGES_1",
        displayName: "沐浴露产品图",
        coreResponsibility: "真实产品身份与包装锚点",
      },
    ],
    requiredAssets: [],
  };

  const issues = inspectFaceAllowedCharacterAnchorPlan(onePersonBeatDraft, {
    deliveryMode: "images_text",
    understandingOnly: false,
    faceReferencePolicy: "faces_allowed",
    expectsUploadedCharacterReference: false,
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /成片明确需要人物/u);
});

test("age synonyms still require a real identity carrier instead of silently dropping it", () => {
  for (const subject of ["幼儿", "孩子", "孩童", "少女", "一名婴儿", "one toddler"]) {
    const candidate = { status: "ready", qualityPlan: { storyBeats: [{ visibleEvent: `${subject}微笑`, promptAnchor: `${subject}微笑` }] }, prompts: [], uploadPlan: [], requiredAssets: [] };
    assert.match(inspectFaceAllowedCharacterAnchorPlan(candidate, { deliveryMode: "images_text", understandingOnly: false, faceReferencePolicy: "faces_allowed", expectsUploadedCharacterReference: false }).join("\n"), /缺少系统生成/u, subject);
  }
});

test("a detailed generated character image satisfies the face-allowed anchor gate", () => {
  const generatedIdentityPrompt =
    "生成一张单人原创虚构成年女性人物身份参考图，清楚正脸与五官结构，椭圆脸、自然眉眼与鼻唇比例清晰；深棕色齐肩发型，中等暖调肤色，匀称体型和真实身体比例，双手与双腿完整可见；穿无标识奶油白背心和深灰短裤。干净中性背景，同一人物，不含文字、Logo、复杂动作、故事场景或额外人物。";
  const draft = {
    status: "ready",
    qualityPlan: {
      storyBeats: [
        { visibleEvent: "她抬起右手", promptAnchor: "她抬手" },
        { visibleEvent: "同一名成年模特转身展示双腿", promptAnchor: "模特转身" },
      ],
    },
    prompts: [{ content: "同一名成年模特完成清洗动作。" }],
    uploadPlan: [
      {
        type: "generated",
        assetKey: "GENERATED_CHARACTER_IDENTITY",
        displayName: "原创成年人物身份图",
        coreResponsibility: "同一人物的身份、脸、发型、肤色、体型与服装锚点",
        doNotReference: "不参考动作、镜头、背景或产品",
      },
    ],
    requiredAssets: [
      {
        kind: "fictional_character_identity_image",
        status: "missing",
        assetKey: "GENERATED_CHARACTER_IDENTITY",
        canGenerate: true,
        generationPrompt: generatedIdentityPrompt,
      },
    ],
  };

  assert.deepEqual(
    inspectFaceAllowedCharacterAnchorPlan(draft, {
      deliveryMode: "images_text",
      understandingOnly: false,
      faceReferencePolicy: "faces_allowed",
      expectsUploadedCharacterReference: false,
    }),
    [],
  );
});

test("a requested portrait-painting identity style must survive generation and binding", () => {
  const generatedIdentityPrompt =
    "生成一张单人原创虚构成年男性肖像画人物身份参考图，清楚正脸与五官结构，方形脸、自然眉眼与鼻唇比例清晰；深棕色短发发型，中等暖调肤色，匀称体型和真实身体比例，双手与肩部可见；穿无标识深灰上衣。干净中性背景，同一人物，不含文字、Logo、复杂动作、故事场景或额外人物。";
  const draft = {
    status: "ready",
    qualityPlan: {
      storyBeats: [
        { visibleEvent: "一名成年男人拿起产品", promptAnchor: "男人拿起产品" },
      ],
    },
    prompts: [
      {
        content:
          "@图片1只负责同一男人的人物身份、外观与肖像画风，不控制动作、镜头、背景或产品。",
      },
    ],
    uploadPlan: [
      {
        type: "generated",
        assetKey: "GENERATED_CHARACTER_IDENTITY",
        displayName: "原创成年男人身份图",
        coreResponsibility: "同一男人的人物身份、外观与肖像画风锚点",
      },
    ],
    requiredAssets: [
      {
        kind: "fictional_character_identity_image",
        status: "missing",
        assetKey: "GENERATED_CHARACTER_IDENTITY",
        canGenerate: true,
        generationPrompt: generatedIdentityPrompt,
      },
    ],
  };
  const options = {
    deliveryMode: "images_text",
    understandingOnly: false,
    faceReferencePolicy: "faces_allowed",
    expectsUploadedCharacterReference: false,
    taskBrief: "男人的图片以肖像画的方式呈现。",
  };

  assert.deepEqual(inspectFaceAllowedCharacterAnchorPlan(draft, options), []);

  draft.requiredAssets[0].generationPrompt =
    generatedIdentityPrompt.replace("肖像画", "写实照片");
  assert.match(
    inspectFaceAllowedCharacterAnchorPlan(draft, options).join("\n"),
    /遗漏用户指定的肖像画风格/u,
  );
});

test("an explicitly supplied target person must stay the face-allowed identity authority", () => {
  const draft = {
    status: "ready",
    qualityPlan: {
      storyBeats: [
        { visibleEvent: "人物直视镜头", promptAnchor: "人物直视镜头" },
        { visibleEvent: "同一人物拿起产品", promptAnchor: "人物拿起产品" },
      ],
    },
    prompts: [{ content: "同一名成年人物完成演示。" }],
    requiredAssets: [],
    uploadPlan: [
      {
        type: "image",
        assetKey: "REFERENCE_IMAGES_2",
        displayName: "用户人物参考图",
        coreResponsibility: "目标人物身份、脸、发型、体型与服装锚点",
      },
    ],
  };
  assert.deepEqual(
    inspectFaceAllowedCharacterAnchorPlan(draft, {
      deliveryMode: "images_text",
      understandingOnly: false,
      faceReferencePolicy: "faces_allowed",
      expectsUploadedCharacterReference: true,
    }),
    [],
  );

  draft.uploadPlan[0].type = "generated";
  assert.match(
    inspectFaceAllowedCharacterAnchorPlan(draft, {
      deliveryMode: "images_text",
      understandingOnly: false,
      faceReferencePolicy: "faces_allowed",
      expectsUploadedCharacterReference: true,
    }).join("\n"),
    /用户人物参考图未/u,
  );
});

test("the character-anchor gate does not change text-only, no-face, or product-only work", () => {
  const recurringPerson = {
    status: "ready",
    qualityPlan: {
      storyBeats: [
        { visibleEvent: "人物抬手", promptAnchor: "人物抬手" },
        { visibleEvent: "人物转身", promptAnchor: "人物转身" },
      ],
    },
    prompts: [{ content: "一名成年演示者完成动作。" }],
    uploadPlan: [],
    requiredAssets: [],
  };
  assert.deepEqual(
    inspectFaceAllowedCharacterAnchorPlan(recurringPerson, {
      deliveryMode: "text_only",
      understandingOnly: false,
      faceReferencePolicy: "faces_allowed",
      expectsUploadedCharacterReference: false,
    }),
    [],
  );
  assert.deepEqual(
    inspectFaceAllowedCharacterAnchorPlan(recurringPerson, {
      deliveryMode: "images_text",
      understandingOnly: false,
      faceReferencePolicy: "no_faces",
      expectsUploadedCharacterReference: false,
    }),
    [],
  );

  const productOnly = {
    status: "ready",
    qualityPlan: {
      storyBeats: [
        { visibleEvent: "泵瓶立在石材台面", promptAnchor: "泵瓶立在台面" },
        { visibleEvent: "水珠沿瓶身滑落", promptAnchor: "水珠沿瓶身滑落" },
      ],
    },
    prompts: [{ content: "固定镜头拍摄产品，禁止出现人物。" }],
    uploadPlan: [],
    requiredAssets: [],
  };
  assert.deepEqual(
    inspectFaceAllowedCharacterAnchorPlan(productOnly, {
      deliveryMode: "images_text",
      understandingOnly: false,
      faceReferencePolicy: "faces_allowed",
      expectsUploadedCharacterReference: false,
    }),
    [],
  );
});

for (const character of [
  "可爱的黑人婴儿，大眼睛、长睫毛，穿米色连体衣和布蝴蝶结",
  "大眼长睫毛的可爱白人小孩，戴小浴帽、穿白色浴袍",
  "70岁的虚构老人，银色短发、戴眼镜，穿蓝色衬衫",
]) {
  test(`identity repair preserves requested character: ${character}`, () => {
    const candidate = {
      status: "ready",
      understanding: { title: "人物展示", viralCore: ["表情变化"], adaptation: `改成：${character}。` },
      qualityPlan: { storyBeats: [{ visibleEvent: "人物抬头微笑", promptAnchor: "人物抬头微笑" }] },
      prompts: [{ title: "final", purpose: "video", content: `0–15秒：${character}抬头微笑。` }],
      uploadPlan: [], requiredAssets: [],
    };
    const options = {
      deliveryMode: "images_text", understandingOnly: false,
      faceReferencePolicy: "faces_allowed", expectsUploadedCharacterReference: false,
      taskBrief: character,
    };
    const snapshot = structuredClone(candidate);
    const repaired = repairFaceAllowedCharacterAnchorPlan(candidate, options);
    assert.deepEqual(candidate, snapshot);
    assert.deepEqual(repaired.understanding, candidate.understanding);
    assert.deepEqual(repaired.qualityPlan, candidate.qualityPlan);
    assert.ok(repaired.requiredAssets[0].generationPrompt.includes(character));
    assert.doesNotMatch(repaired.requiredAssets[0].generationPrompt, /25岁|18岁以上|成年演员/u);
    assert.equal(repaired.requiredAssets[0].canGenerate, true);
    assert.deepEqual(inspectFaceAllowedCharacterAnchorPlan(repaired, options), []);
    assert.deepEqual(repairFaceAllowedCharacterAnchorPlan(repaired, options), repaired, "repair is idempotent");
  });
}

test("provided and not-applicable assets drop stray generation metadata deterministically", () => {
  const candidate = {
    requiredAssets: [
      {
        kind: "unused",
        status: "not_applicable",
        assetKey: "SHOULD_BE_EMPTY",
        reason: "not needed",
        generationPrompt: "stale prompt",
        canGenerate: true,
        dependsOnAssetKeys: ["REFERENCE_IMAGES_1"],
      },
      {
        kind: "product",
        status: "provided",
        assetKey: "REFERENCE_IMAGES_1",
        reason: "provided product",
        generationPrompt: "stale prompt",
        canGenerate: true,
        dependsOnAssetKeys: ["REFERENCE_IMAGES_1"],
      },
    ],
  };
  const snapshot = structuredClone(candidate);
  const normalized = normalizeDirectorAssetStatusMetadata(candidate);
  assert.deepEqual(candidate, snapshot, "normalization must not mutate the draft");
  assert.deepEqual(normalized.requiredAssets[0], {
    kind: "unused",
    status: "not_applicable",
    assetKey: "",
    reason: "not needed",
    generationPrompt: "",
    canGenerate: false,
    dependsOnAssetKeys: [],
  });
  assert.deepEqual(normalized.requiredAssets[1], {
    kind: "product",
    status: "provided",
    assetKey: "REFERENCE_IMAGES_1",
    reason: "provided product",
    generationPrompt: "",
    canGenerate: false,
    dependsOnAssetKeys: [],
  });
});

test("a recognized uploaded face is not overwritten merely because the brief omitted 'reference'", () => {
  const candidate = {
    status: "ready", qualityPlan: { storyBeats: [{ visibleEvent: "人物对镜头微笑" }] },
    uploadPlan: [{ type: "image", assetKey: "REFERENCE_IMAGES_1", displayName: "人物身份图", coreResponsibility: "人物身份、脸部与服装" }],
    requiredAssets: [{ status: "provided", assetKey: "REFERENCE_IMAGES_1" }],
  };
  const options = { deliveryMode: "images_text", understandingOnly: false, faceReferencePolicy: "faces_allowed", expectsUploadedCharacterReference: false, taskBrief: "他笑一下" };
  assert.deepEqual(inspectFaceAllowedCharacterAnchorPlan(candidate, options), []);
  assert.equal(repairFaceAllowedCharacterAnchorPlan(candidate, options), candidate);
});

test("concrete facial anatomy and an age-qualified single subject do not need boilerplate repair", () => {
  const candidate = {
    status: "ready", understanding: { title: "儿童展示", adaptation: "改成一名虚构幼儿" },
    qualityPlan: { storyBeats: [{ visibleEvent: "幼儿微笑" }] },
    prompts: [{ content: "0–15秒：幼儿微笑。" }],
    uploadPlan: [{ type: "generated", assetKey: "CHILD", displayName: "儿童身份图", coreResponsibility: "锁定幼儿脸部、发型、肤色、体型和服装" }],
    requiredAssets: [{ status: "missing", kind: "fictional_character_identity_image", canGenerate: true, assetKey: "CHILD", dependsOnAssetKeys: [], generationPrompt: "单一连贯画面、仅一名原创虚构的约3岁幼儿，正面三分之二身，干净浅灰中性背景。圆润偏椭圆脸，饱满额头、柔和颧骨、短小下颌与圆下巴；大而清澈的杏圆眼、修长自然睫毛、弧形眉；短鼻梁、圆鼻尖、饱满唇形。白皙偏暖肤色，深金棕色短卷发、自然发际线；自然幼儿肩线与体型，穿白色浴袍，双手自然可见，不持产品，无额外人物。" }],
  };
  const options = { deliveryMode: "images_text", understandingOnly: false, faceReferencePolicy: "faces_allowed", expectsUploadedCharacterReference: false, taskBrief: "一名原创虚构幼儿" };
  assert.deepEqual(inspectFaceAllowedCharacterAnchorPlan(candidate, options), []);
  assert.equal(repairFaceAllowedCharacterAnchorPlan(candidate, options), candidate);
});

test("usable identity wording still repairs wrong metadata and preserves appearance style", () => {
  const candidate = {
    status: "ready", understanding: { title: "水彩婴儿", adaptation: "改成：一个戴粉色帽子的婴儿" },
    qualityPlan: { storyBeats: [{ visibleEvent: "婴儿微笑" }] },
    prompts: [{ content: "0–15秒：水彩婴儿微笑。" }],
    uploadPlan: [{ type: "generated", assetKey: "BABY", displayName: "人物身份图", coreResponsibility: "水彩人物身份、脸部与服装", doNotReference: "不参考动作和背景" }],
    requiredAssets: [{ kind: "wrong_kind", status: "provided", assetKey: "BABY", canGenerate: false, dependsOnAssetKeys: ["SCENE"], generationPrompt: "单人原创虚构婴儿的水彩身份图，大眼睛，圆润脸部结构与五官结构，黑色短发发型，温暖棕色肤色，婴儿身体比例，粉色帽子和白色衣着，干净中性背景，同一人物，无其他人物和产品，不改变肤色、帽子、服装与画风。" }],
  };
  const options = { deliveryMode: "images_text", understandingOnly: false, faceReferencePolicy: "faces_allowed", expectsUploadedCharacterReference: false, taskBrief: "一个水彩婴儿" };
  const fixed = repairFaceAllowedCharacterAnchorPlan(candidate, options);
  assert.equal(fixed.requiredAssets[0].status, "missing");
  assert.equal(fixed.requiredAssets[0].canGenerate, true);
  assert.equal(fixed.requiredAssets[0].generationPrompt, candidate.requiredAssets[0].generationPrompt);
  assert.deepEqual(fixed.requiredAssets[0].dependsOnAssetKeys, ["SCENE"]);
  assert.match(fixed.uploadPlan[0].coreResponsibility, /水彩/u);
  assert.deepEqual(inspectFaceAllowedCharacterAnchorPlan(fixed, options), []);
  assert.deepEqual(repairFaceAllowedCharacterAnchorPlan(fixed, options), fixed);
});

test("a child-named identity carrier is recognized without adding a second competing face", () => {
  const candidate = {
    status: "ready", understanding: { title: "儿童推荐", adaptation: "改成：戴浴帽的可爱儿童" },
    qualityPlan: { storyBeats: [{ visibleEvent: "孩子微笑" }] },
    prompts: [{ content: "@图片1只负责锁定同一名儿童的脸部、肤色、发型、体型、年龄感、浴帽和浴袍；不参考动作、镜头、背景和产品。" }],
    uploadPlan: [{ type: "generated", assetKey: "FICTIONAL_CHILD_IDENTITY", displayName: "原创浴袍儿童身份图", coreResponsibility: "锁定同一名儿童的脸部、肤色、发型、体型、年龄感、浴帽和浴袍" }],
    requiredAssets: [{ status: "missing", kind: "fictional_character_identity_image", canGenerate: true, assetKey: "FICTIONAL_CHILD_IDENTITY", dependsOnAssetKeys: [], generationPrompt: "生成原创虚构儿童身份图，一名儿童约四岁，大眼睛、自然长睫毛、圆润脸部结构、饱满脸颊，浅棕细软头发收入浴帽，暖调肤色，幼儿身体比例与窄肩，穿白色浴袍，双手清楚可见，正面半身照。干净浅灰背景，不持产品，不增添人物，不含文字或复杂动作。" }],
  };
  const options = { deliveryMode: "images_text", understandingOnly: false, faceReferencePolicy: "faces_allowed", expectsUploadedCharacterReference: false, taskBrief: "可爱儿童" };
  assert.deepEqual(inspectFaceAllowedCharacterAnchorPlan(candidate, options), []);
  assert.equal(repairFaceAllowedCharacterAnchorPlan(candidate, options), candidate);
  assert.equal(candidate.uploadPlan.length, 1);
});

test("final production restores the employee-confirmed direction and mapping sources", () => {
  const candidate = {
    routing: { mode: "CONTENT_IMITATION", rationale: "model paraphrase" },
    understanding: {
      title: "rewritten title",
      viralCore: ["rewritten mechanism"],
      adaptation: "rewritten adaptation",
    },
    qualityPlan: {
      mechanismMappings: [
        {
          sourceMechanism: "rewritten mechanism",
          targetVisibleEvent: "成年演员按下泵头",
        },
      ],
    },
  };
  const params = {
    analysisConfirmed: true,
    confirmedRouting: {
      mode: "CONTENT_IMITATION",
      rationale: "employee-confirmed route",
    },
    confirmedUnderstanding: {
      title: "confirmed title",
      viralCore: ["confirmed mechanism"],
      adaptation: "confirmed adaptation",
    },
  };
  const restored = restoreConfirmedDirectorDirection(candidate, params);
  assert.deepEqual(restored.routing, params.confirmedRouting);
  assert.deepEqual(restored.understanding, params.confirmedUnderstanding);
  assert.equal(
    restored.qualityPlan.mechanismMappings[0].sourceMechanism,
    "confirmed mechanism",
  );
  assert.equal(
    restored.qualityPlan.mechanismMappings[0].targetVisibleEvent,
    "成年演员按下泵头",
    "target production detail must remain untouched",
  );
  assert.equal(
    candidate.qualityPlan.mechanismMappings[0].sourceMechanism,
    "rewritten mechanism",
    "restoration must not mutate the model draft",
  );
});

test("a missing single-adult identity anchor is completed without another model repair", () => {
  const candidate = {
    status: "ready",
    understanding: {
      title: "成年女性演示产品",
      adaptation:
        "改成：一名大眼、长睫毛、穿白色浴袍的25岁成年女性。",
    },
    qualityPlan: {
      storyBeats: [
        {
          visibleEvent: "成年女性举起产品",
          promptAnchor: "成年女性举起产品",
        },
        {
          visibleEvent: "同一名成年女性按下泵头",
          promptAnchor: "成年女性按下泵头",
        },
      ],
    },
    prompts: [
      {
        title: "final",
        purpose: "video",
        content:
          "素材职责：\n@图片1只负责真实产品身份与包装，不参考人物、动作、镜头或背景。\n0–7秒：成年女性举起产品。\n7–15秒：成年女性按下泵头。",
      },
    ],
    uploadPlan: [
      {
        order: 1,
        reference: "@图片1",
        assetKey: "REFERENCE_IMAGES_1",
        displayName: "产品图",
        type: "image",
        coreResponsibility: "真实产品身份与包装",
        doNotReference: "不参考人物、动作、镜头或背景",
        timeRange: "全片",
      },
    ],
    requiredAssets: [
      {
        kind: "real_product_image",
        status: "provided",
        assetKey: "REFERENCE_IMAGES_1",
        reason: "产品真值",
        generationPrompt: "",
        canGenerate: false,
        dependsOnAssetKeys: [],
      },
    ],
  };
  const repaired = repairFaceAllowedCharacterAnchorPlan(candidate, {
    deliveryMode: "images_text",
    understandingOnly: false,
    faceReferencePolicy: "faces_allowed",
    expectsUploadedCharacterReference: false,
    taskBrief: "使用一名25岁成年女性展示产品。",
  });
  assert.deepEqual(
    inspectFaceAllowedCharacterAnchorPlan(repaired, {
      deliveryMode: "images_text",
      understandingOnly: false,
      faceReferencePolicy: "faces_allowed",
      expectsUploadedCharacterReference: false,
      taskBrief: "使用一名25岁成年女性展示产品。",
    }),
    [],
  );
  assert.equal(repaired.uploadPlan.length, 2);
  assert.equal(repaired.uploadPlan[1].reference, "@图片2");
  assert.equal(repaired.uploadPlan[1].type, "generated");
  assert.match(repaired.prompts[0].content, /@图片2/u);
  assert.match(
    repaired.requiredAssets[1].generationPrompt,
    /单一连贯画面的原创虚构人物身份参考图/u,
  );
  assert.equal(candidate.uploadPlan.length, 1, "repair must not mutate the draft");
});

test("absolute-path redaction preserves package measurements", () => {
  assert.equal(
    redactAbsolutePaths("300 ml / 10.14 fl. oz."),
    "300 ml / 10.14 fl. oz.",
  );
  assert.equal(
    redactAbsolutePaths("read /tmp/private/input.png now"),
    "read [absolute-path-redacted] now",
  );
  assert.equal(
    redactAbsolutePaths("read D:\\private\\input.png now"),
    "read [absolute-path-redacted]",
  );
  assert.equal(hasAbsolutePath("300 ml / 10.14 fl. oz."), false);
  assert.equal(hasAbsolutePath("read /tmp/private/input.png now"), true);
});

test("unknown provided keys and undeclared upload keys enter bounded repair", () => {
  const candidate = {
    requiredAssets: [
      {
        status: "provided",
        assetKey: "PERSON_REFERENCE_IMAGE_1",
      },
    ],
    uploadPlan: [
      { assetKey: "PERSON_REFERENCE_IMAGE_1" },
      { assetKey: "REFERENCE_IMAGES_2" },
    ],
  };
  const snapshot = structuredClone(candidate);
  const issues = inspectDirectorAssetPlanKeyConsistency(candidate, [
    "REFERENCE_IMAGES_1",
  ]);

  assert.equal(issues.length, 3);
  assert.ok(issues.every(isRecoverableAssetPlanIssue));
  assert.match(issues.join("\n"), /PERSON_REFERENCE_IMAGE_1/u);
  assert.match(issues.join("\n"), /REFERENCE_IMAGES_2/u);
  assert.deepEqual(candidate, snapshot, "inspection must never remap an unknown key");
});

test("new generated keys stay valid when explicitly declared missing", () => {
  const candidate = {
    requiredAssets: [
      {
        status: "provided",
        assetKey: "REFERENCE_IMAGES_1",
      },
      {
        status: "missing",
        assetKey: "FACELESS_SHOULDER_ACTION_IMAGE",
      },
    ],
    uploadPlan: [
      { assetKey: "REFERENCE_IMAGES_1" },
      { assetKey: "FACELESS_SHOULDER_ACTION_IMAGE" },
    ],
  };

  assert.deepEqual(
    inspectDirectorAssetPlanKeyConsistency(candidate, ["REFERENCE_IMAGES_1"]),
    [],
  );
});

test("task-specific schema guides provided keys without forbidding missing keys", () => {
  const schema = buildDirectorOutputSchemaForAssets(["REFERENCE_IMAGES_1"]);
  const requiredAssetKey =
    schema.properties.requiredAssets.items.properties.assetKey;
  const uploadAssetKey = schema.properties.uploadPlan.items.properties.assetKey;

  assert.match(requiredAssetKey.description, /REFERENCE_IMAGES_1/u);
  assert.match(requiredAssetKey.description, /status=missing/u);
  assert.match(uploadAssetKey.description, /requiredAssets/u);
  assert.equal(
    new RegExp(requiredAssetKey.pattern).test("NEW_GENERATED_IMAGE"),
    true,
  );
  assert.equal(new RegExp(requiredAssetKey.pattern).test(""), true);
});

test("text-only product delivery requires an executable visual identity lock", () => {
  assert.ok(
    inspectTextOnlyProductIdentityLock(
      "这是一款白色沐浴露，全片保持一致。",
    ).length > 0,
  );
  assert.deepEqual(
    inspectTextOnlyProductIdentityLock(
      "产品身份锁定：高细白色圆柱瓶身，高宽比例固定；圆肩、白色泵头和瓶身部件布局不变。主色为白色，标签有黑绿色块和哑光材质，Logo位于上方，只保留确认可读的品牌和品名。全片同一产品，禁止改款、改色、部件漂移、Logo漂移、镜像字或乱码。",
    ),
    [],
  );
});

test("restricted asset repair may rebind references but cannot rewrite story", () => {
  const base = {
    taskMode: "HYBRID",
    routing: { mode: "CONTENT_IMITATION", rationale: "replace product" },
    understanding: { title: "same story" },
    qualityPlan: { hook: { visibleEvent: "hand reaches shoulder" } },
    expressionTimeline: [],
    executionCard: { duration: "15" },
    prompts: [
      {
        title: "final",
        purpose: "video",
        content:
          "素材职责：\n@图片2只负责产品，不参考动作。\n0–5秒：人物抬手清洗肩膀。",
      },
    ],
  };
  const rebound = structuredClone(base);
  rebound.prompts[0].content =
    "素材职责：\n@图片1只负责产品，不参考动作。\n0–5秒：人物抬手清洗肩膀。";
  rebound.uploadPlan = [{ assetKey: "REFERENCE_IMAGES_1" }];
  rebound.requiredAssets = [
    { status: "provided", assetKey: "REFERENCE_IMAGES_1" },
  ];
  assert.deepEqual(inspectRestrictedAssetPlanRepairDrift(base, rebound), []);

  const rewritten = structuredClone(rebound);
  rewritten.qualityPlan.hook.visibleEvent = "different hook";
  rewritten.prompts[0].content = rewritten.prompts[0].content.replace(
    "清洗肩膀",
    "展示瓶子",
  );
  const drift = inspectRestrictedAssetPlanRepairDrift(base, rewritten);
  assert.match(drift.join("\n"), /qualityPlan/u);
  assert.match(drift.join("\n"), /提示词内容/u);
});
