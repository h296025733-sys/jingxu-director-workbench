const INTERNAL_WORKFLOW_PATTERNS: readonly RegExp[] = [
  /(?:网页|工作台|后台)(?:会|将|已|正在|负责|自动|另行|准备|生成|处理|提供|等待|安排|完成)/i,
  /系统(?:(?:会|将|已|正在|负责|自动|稍后|另行|再)\s*)+(?:生成|处理|提供|等待|安排|完成|替换|上传)/i,
  /(?:员工|工作人员|管理员)(?:需要|需|应|必须|请|会|将|已经|已|正在|负责|确认|校对|审核|验收|复核|检查|选择|上传|补充|处理|决定|操作)/i,
  /(?:同事|团队)(?:需要|需|应|必须|请|会|将|已经|已|正在|负责|确认|校对|审核|验收|复核|检查|选择|上传|补充|处理|决定|操作)/i,
  /用户(?:需要|需|应|必须|请|会|将|已经|已|正在|负责)?(?:人工)?(?:确认|校对|审核|验收|复核|检查|上传|补充)/i,
  /人工(?:确认|校对|审核|验收|复核|检查|选择|上传|补充|处理|决定|操作)/i,
  /(?:需|需要|等待|尚待|待)(?:由)?(?:员工|用户|人工|工作人员|管理员)(?:进行)?(?:确认|校对|审核|验收|复核|检查|选择|上传|补充|处理|决定|操作)/i,
  /(?:最终|具体|说话者|台词|发音|文本|版本|素材|结果).{0,24}(?:以|由).{0,12}(?:人工|员工|用户|网页).{0,12}(?:确认|校对|审核|验收|复核|结果|为准)/i,
  /(?:草案|候选(?:图|片|视频|版本|素材)|待确认|待补充|待审核|待验收|未确认|尚未确认|未测试|尚未测试|未经测试|需要重做|需重做|正在生成|排队中)/i,
  /(?:codex|chatgpt|assetkey|generationprompt|uploadplan|requiredassets|verification|needs_input|blocked)/i,
  /(?:human|manual|employee|user)\s+(?:review|confirmation|approval|proofread|check|upload|selection)/i,
  /reviewer\s+(?:review|confirmation|approval|proofread|check)/i,
  /(?:needs?\s+(?:human|manual)\s+(?:review|confirmation)|pending\s+(?:review|confirmation|approval)|not\s+(?:yet\s+)?(?:tested|verified)|web\s*app|workbench)/i,
  /upload\s+@?(?:image|video|audio)\d*.{0,40}(?:paste|copy).{0,20}prompt/i,
  /上传\s*@?(?:图片|视频|音频)\d*.{0,40}(?:复制|粘贴).{0,20}提示词/i,
  /(?:客户|甲方|品牌方|负责人)(?:需要|需|应|必须|请|会|将|确认|校对|审核|验收|复核|检查|选择|采用|决定|操作)/i,
  /(?:最终|具体|说话者|台词|发音|文本|版本|素材|结果).{0,24}(?:以|由).{0,12}(?:客户|甲方|品牌方|负责人).{0,12}(?:确认|校对|审核|验收|复核|结果|为准)/i,
  /(?:上传顺序|素材清单|交付附件|采用版本|审核通过后|确认通过后)/i,
  /(?:先|请|需要|需)?(?:在.{0,12})?(?:上传|添加|选择)(?:参考)?(?:素材|附件|图片|视频|音频).{0,30}(?:再|然后|后)?(?:复制|粘贴|生成|提交)/i,
];

/** Final prompts are pasted directly into Seedance and must not expose app workflow. */
export function containsInternalWorkflowLanguage(content: string): boolean {
  return INTERNAL_WORKFLOW_PATTERNS.some((pattern) => pattern.test(content));
}

const SPOKEN_LANGUAGE_TOKEN_PATTERN =
  /普通话|中文|汉语|英语|英文|西班牙语|西语|葡萄牙语|葡语|法语|德语|意大利语|日语|韩语|俄语|阿拉伯语|mandarin|chinese|english|spanish|portuguese|french|german|italian|japanese|korean|russian|arabic/giu;
const SPOKEN_LANGUAGE_CONTEXT_PATTERN =
  /口播|旁白|画外音|对白|台词|配音|说话|发音|声线|女声|男声|童声|童音|语言|voice(?:-?over)?|narration|dialogue|spoken|speech|speaker|speaks?|language/iu;
const VIDEO_LANGUAGE_CONTEXT_PATTERN =
  /(?:版本|版|视频|短片|广告|成片|video|ad|advert|commercial|version)/iu;
const NON_SPOKEN_LANGUAGE_CONTEXT_PATTERN =
  /(?:包装|标签|瓶身|产品|Logo|logo|字幕|屏幕|可见文字|文案|品名|型号|package|label|product|subtitle|on-screen|copy)/iu;

function canonicalSpokenLanguage(token: string): string {
  if (/^(?:英语|英文|english)$/iu.test(token)) return "英语";
  if (/^(?:普通话|中文|汉语|mandarin|chinese)$/iu.test(token)) return "中文";
  if (/^(?:西班牙语|西语|spanish)$/iu.test(token)) return "西班牙语";
  if (/^(?:葡萄牙语|葡语|portuguese)$/iu.test(token)) return "葡萄牙语";
  if (/^(?:法语|french)$/iu.test(token)) return "法语";
  if (/^(?:德语|german)$/iu.test(token)) return "德语";
  if (/^(?:意大利语|italian)$/iu.test(token)) return "意大利语";
  if (/^(?:日语|japanese)$/iu.test(token)) return "日语";
  if (/^(?:韩语|korean)$/iu.test(token)) return "韩语";
  if (/^(?:俄语|russian)$/iu.test(token)) return "俄语";
  if (/^(?:阿拉伯语|arabic)$/iu.test(token)) return "阿拉伯语";
  return token;
}

/**
 * Detect only a language choice connected to speech or the requested video
 * version. Packaging text such as "the label is English" is not a voice choice.
 */
export function explicitSpokenLanguageFromBrief(brief: string): string | null {
  let selected: { language: string; score: number; index: number } | null = null;
  for (const match of brief.matchAll(SPOKEN_LANGUAGE_TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    const start = Math.max(0, index - 28);
    const end = Math.min(brief.length, index + match[0].length + 28);
    const context = brief.slice(start, end);
    const localStart = Math.max(0, index - 16);
    const localEnd = Math.min(brief.length, index + match[0].length + 16);
    const localContext = brief.slice(localStart, localEnd);
    const speechContext = context.replace(
      /(?:无|不要|不使用|不出现|不加|禁止添加|取消)(?:任何)?(?:口播|旁白|画外音|对白|台词|配音)/gu,
      "",
    );
    const localSpeechContext = localContext.replace(
      /(?:无|不要|不使用|不出现|不加|禁止添加|取消)(?:任何)?(?:口播|旁白|画外音|对白|台词|配音)/gu,
      "",
    );
    const nonSpokenTextLanguage =
      NON_SPOKEN_LANGUAGE_CONTEXT_PATTERN.test(localContext) &&
      !SPOKEN_LANGUAGE_CONTEXT_PATTERN.test(localSpeechContext);
    const score = nonSpokenTextLanguage
      ? 0
      : SPOKEN_LANGUAGE_CONTEXT_PATTERN.test(speechContext)
      ? 3
      : VIDEO_LANGUAGE_CONTEXT_PATTERN.test(context)
        ? 2
        : 0;
    if (
      score > 0 &&
      (!selected || score > selected.score || (score === selected.score && index > selected.index))
    ) {
      selected = {
        language: canonicalSpokenLanguage(match[0]),
        score,
        index,
      };
    }
  }
  return selected?.language ?? null;
}

function collectPromptSpokenSegments(content: string): string[] {
  const segments: string[] = [];
  const quotedSpeech =
    /(?:口播|旁白|画外音|对白|台词|女声|男声|voice(?:-?over)?|narration|dialogue|line|(?:说|问|答|喊))\s*[：:]?\s*[“"]([^”"\r\n]+)[”"]/giu;
  for (const match of content.matchAll(quotedSpeech)) {
    const value = String(match[1] ?? "").trim();
    if (value) segments.push(value);
  }
  const prefixedSpeech =
    /(?:口播|旁白|画外音|对白|台词|女声|男声|voice(?:-?over)?|narration|dialogue|line)\s*[：:]\s*([^\r\n]+)/giu;
  for (const match of content.matchAll(prefixedSpeech)) {
    const value = String(match[1] ?? "")
      .replace(/^[\s“"]+|[\s”"]+$/gu, "")
      .trim();
    if (
      value &&
      !segments.some((existing) => value.includes(existing) || existing.includes(value))
    ) {
      segments.push(value);
    }
  }
  return segments;
}

/**
 * Website default: spoken copy is English unless the employee explicitly
 * asks for another language. Directing prose may remain Chinese.
 */
export function inspectDefaultEnglishSpokenLanguage(
  content: string,
  brief: string,
): string[] {
  const requestedLanguage = explicitSpokenLanguageFromBrief(brief);
  if (requestedLanguage && requestedLanguage !== "英语") return [];

  const spokenSegments = collectPromptSpokenSegments(content);
  const explicitlyNoSpeech =
    /(?:无|不要|不使用|不出现|不加|禁止添加|取消)(?:任何)?(?:口播|旁白|画外音|对白|台词|配音)|(?:口播|旁白|画外音|对白|台词|配音)(?:关闭|取消|不要|无)/u.test(
      content,
    );
  const declaresSpokenContent =
    spokenSegments.length > 0 ||
    (!explicitlyNoSpeech &&
      /(?:制作|生成|全片|使用|包含).{0,24}(?:口播|旁白|画外音|对白|台词|配音|voice(?:-?over)?|narration|dialogue)/iu.test(
        content,
      ));
  if (!declaresSpokenContent) return [];

  const hasEnglishDeclaration =
    /(?:英语|英文|English).{0,18}(?:口播|旁白|画外音|对白|台词|配音|童声|童音|女声|男声|声线|讲解|说话|voice(?:-?over)?|narration|dialogue|speech)|(?:口播|旁白|画外音|对白|台词|配音|童声|童音|女声|男声|声线|讲解|说话|voice(?:-?over)?|narration|dialogue|speech).{0,18}(?:英语|英文|English)/iu.test(
      content,
    );
  const hasChineseSpokenCopy = spokenSegments.some((segment) =>
    /[\u3400-\u9fff]/u.test(segment),
  );
  const hasMissingEnglishCopy = spokenSegments.some(
    (segment) => !/[A-Za-z]+(?:['’][A-Za-z]+)?/u.test(segment),
  );
  const declaresChineseSpeech = content.split(/[。；;，,\n]/u).some((clause) => {
    // "不生成中文口播" is a prohibition, not a request for Chinese speech.
    // Keep clause boundaries: an English declaration before a semicolon must
    // not become paired with the Chinese prohibition after it.
    if (/(?:不要|不得|不准|不生成|不使用|不加入|不添加|不采用|不出现|禁止|避免|无需|取消)(?:再|生成|使用|加入|添加|采用|出现|任何|额外|的|\s){0,8}(?:中文|汉语|普通话)/u.test(clause)) return false;
    return /(?:中文|汉语|普通话).{0,18}(?:口播|旁白|画外音|对白|台词|配音|童声|女声|男声)|(?:口播|旁白|画外音|对白|台词|配音|童声|女声|男声).{0,18}(?:中文|汉语|普通话)/u.test(clause);
  });
  if (
    hasEnglishDeclaration &&
    !declaresChineseSpeech &&
    !hasChineseSpokenCopy &&
    !hasMissingEnglishCopy
  ) {
    return [];
  }
  return [
    "口播默认语言错误：用户没有明确指定其他语言时，所有口播、旁白和对白必须是自然英文，并在提示词中明确标注英语；导演说明仍可使用中文",
  ];
}

export function briefClaimsUploadedProductReference(brief: string): boolean {
  const claims = [
    /(?:图片|图[一二三四五六七八九\d]*|照片).{0,12}(?:是|为|展示|属于).{0,8}(?:我的|我们的|我司的|公司的|自家|本公司的|真实)?(?:产品|商品|包装)/i,
    /(?:我的|我们的|我司的|公司的|自家|本公司的|真实)(?:产品|商品|包装).{0,12}(?:图|图片|照片|已上传|已提供|附件)/i,
    /(?:产品|商品|包装)(?:图|图片|照片).{0,12}(?:已上传|已提供|在附件|附上)/i,
    /(?:uploaded|attached)\s+(?:image|photo).{0,20}(?:my|our|company)\s+(?:product|packaging)/i,
    /(?:my|our|company)\s+(?:product|packaging).{0,20}(?:image|photo|attached|uploaded)/i,
    /这(?:就是|是)(?:我的|我们的|我司的|公司的|自家|本公司的|真实)?(?:产品|商品|包装)(?:[，,。\s]|$)/i,
    /这(?:张|些)?(?:图|图片|照片)?(?:里|中)?(?:的)?(?:就是|是)?(?:我的|我们的|我司的|公司的|自家|本公司的|真实)?(?:产品|商品|包装).{0,20}(?:做广告|拍广告|用于广告|作为参考|给\s*Seedance)?/i,
    /(?:附件|附图|上图|这张图|这些图).{0,12}(?:就是|是|包含|展示).{0,8}(?:我的|我们的|我司的|公司的|自家|本公司的|真实)?(?:产品|商品|包装)/i,
    /(?:这款|该款|这瓶|该瓶|这个|该|此)(?:产品|商品|包装|沐浴露|洗面奶|洗发水|护肤品|化妆品|清洁用品|设备|手机|机器|器具).{0,16}[【\[]?\s*(?:参考)?(?:图片|图)\s*[一二三四五六七八九十\d]+\s*[】\]]?/iu,
    /[【\[]?\s*(?:参考)?(?:图片|图)\s*[一二三四五六七八九十\d]+\s*[】\]]?.{0,16}(?:是|为|作为|展示|对应|里的|中的).{0,8}(?:这款|该款|这瓶|该瓶|我的|我们的|我司的|公司的|真实)?(?:产品|商品|包装|沐浴露|洗面奶|洗发水|护肤品|化妆品|清洁用品|设备)/iu,
  ];
  return claims.some((pattern) => pattern.test(brief));
}

/** Product-science requests need a causal animation, not four ingredient cards. */
export function briefRequestsProductScienceAnimation(brief: string): boolean {
  const asksForExplanation =
    /(?:科普|原理|机制|成分|配方|如何起作用|怎么起作用|为什么有效|微观|动画演示|science|scientific|mechanism|ingredient)/iu.test(
      brief,
    );
  const namesProductOrBenefit =
    /(?:产品|商品|沐浴露|洗面奶|洗发水|护肤|清洁|精华|面霜|乳液|水杨酸|果酸|茶树|薄荷|salicylic|aha|bha|body\s*wash|cleanser|benefit|痛点|问题|效果)/iu.test(
      brief,
    );
  return asksForExplanation && namesProductOrBenefit;
}

/**
 * Keep this deliberately conservative: it only enables the character-text
 * quality gate when the brief itself connects an uploaded image to a person.
 * The director still visually classifies every attached image even when the
 * employee does not use one of these phrases.
 */
export function briefClaimsUploadedCharacterReference(brief: string): boolean {
  const claims = [
    /(?:参考图片|参考图|图片|照片)\s*[一二三四五六七八九十\d]*\s*(?:是|为|作为|用作|里的|中的|展示|包含).{0,10}(?:人物|角色|演员|模特|人像|肖像|脸|外貌|长相|形象)/iu,
    /(?:人物|角色|演员|模特|人像|肖像|脸|外貌|长相|形象).{0,10}(?:来自|使用|参考|按照|照着|保留).{0,10}(?:参考图片|参考图|图片|照片)\s*[一二三四五六七八九十\d]*/iu,
    /(?:这张|这幅|上传的|附上的|附件里的)(?:人物|角色|人像|肖像)?(?:图|图片|照片).{0,12}(?:人物|角色|演员|模特|人像|肖像|脸|外貌|长相|形象)/iu,
    /(?:把|将)(?:这张|这幅|上传的|附上的|附件里的)?(?:图|图片|照片)(?:里|中)?的?(?:人|人物|角色|演员|模特).{0,20}(?:作为|换成|放进|用在|保留|参考)/iu,
    /(?:uploaded|attached|reference)\s+(?:image|photo).{0,24}(?:person|character|actor|model|portrait|face|appearance)/iu,
    /(?:person|character|actor|model|portrait|face|appearance).{0,24}(?:uploaded|attached|reference)\s+(?:image|photo)/iu,
  ];
  return claims.some((pattern) => pattern.test(brief));
}

export const CHARACTER_IDENTITY_LOCK_ISSUE_PREFIX = "纯文字人物身份锁";

/**
 * If a supplied person image cannot travel with the final package, the prompt
 * needs a compact visual identity specification rather than labels such as
 * "young woman" or "handsome man". This checks only observable appearance;
 * it intentionally does not invite sensitive-trait or personality inference.
 */
export function inspectCharacterIdentityTextLock(content: string): string[] {
  const marker =
    /(?:人物|角色)(?:视觉)?身份锁定\s*[：:]|character\s+(?:visual\s+)?identity\s+lock\s*:/iu;
  const markerMatch = marker.exec(content);
  if (!markerMatch || markerMatch.index === undefined) {
    return [
      `${CHARACTER_IDENTITY_LOCK_ISSUE_PREFIX}缺少独立的“人物身份锁定”段，不能只写年龄、性别、发色或“高颜值”`,
    ];
  }

  const lock = content.slice(markerMatch.index, markerMatch.index + 1000);
  const coreFeatures: readonly [string, RegExp][] = [
    [
      "脸型与骨骼轮廓",
      /(?:脸型|面部轮廓|下颌线?|下巴|颧骨|额头|发际线|鹅蛋脸|圆脸|方脸|长脸|窄脸|face\s*shape|facial\s*contour|jawline|chin|cheekbone|forehead|hairline)/iu,
    ],
    [
      "眉眼形状与比例",
      /(?:眉形|眉峰|眉距|眉毛|眼型|眼距|眼睑|眼裂|眼角|单眼皮|双眼皮|杏眼|凤眼|brow|eyebrow|eye\s*shape|eye\s*spacing|eyelid|eye\s*corner)/iu,
    ],
    [
      "鼻部与唇部结构",
      /(?:鼻梁|鼻根|鼻尖|鼻翼|鼻型|唇形|唇峰|唇厚|嘴角|上唇|下唇|nose\s*bridge|nose\s*tip|nostril|nose\s*shape|lip\s*shape|lip\s*fullness|cupid.?s\s*bow|mouth\s*corner)/iu,
    ],
    [
      "发型、分缝、质地与长度",
      /(?:发型|发色|分缝|中分|侧分|刘海|卷度|卷发|直发|波浪发|长发|短发|发量|蓬松度|hair\s*color|hair\s*part|hair\s*texture|hair\s*length|bangs|fringe|curls?|waves?)/iu,
    ],
    [
      "可见肤色与冷暖调",
      /(?:肤色|肤调|皮肤色调|冷调皮肤|暖调皮肤|中性调皮肤|skin\s*tone|skin\s*undertone|complexion)/iu,
    ],
  ];
  const supportFeatures: readonly [string, RegExp][] = [
    [
      "体型、肩线或身材比例",
      /(?:体型|身形|肩宽|肩线|骨架|身材比例|躯干比例|高挑|修长|健壮|纤细|physique|body\s*build|body\s*shape|shoulder\s*line|shoulder\s*width|body\s*proportion|silhouette)/iu,
    ],
    [
      "服装结构、材质与配饰",
      /(?:服装|上衣|衬衫|夹克|外套|连衣裙|裤装|领口|袖型|剪裁|面料|材质|配饰|耳环|项链|眼镜|wardrobe|outfit|neckline|sleeve|cut|fabric|material|accessor|earring|necklace|glasses)/iu,
    ],
    [
      "可见识别特征",
      /(?:痣|雀斑|酒窝|疤痕|胡须|络腮胡|小胡子|胎记|visible\s*mark|mole|freckle|dimple|scar|beard|mustache|moustache)/iu,
    ],
  ];
  const missingCore = coreFeatures
    .filter(([, pattern]) => !pattern.test(lock))
    .map(([label]) => label);
  const hasSupport = supportFeatures.some(([, pattern]) => pattern.test(lock));
  const issues: string[] = [];
  if (missingCore.length > 0 || !hasSupport) {
    const missing = [
      ...missingCore,
      ...(!hasSupport ? ["体型、服装或可见识别特征至少一项"] : []),
    ];
    issues.push(
      `${CHARACTER_IDENTITY_LOCK_ISSUE_PREFIX}不够具体，缺少${missing.join("、")}；只写“年轻、漂亮、长发、暖肤色”不能复现参考人物`,
    );
  }

  const hasSamePersonLock =
    /(?:全片|跨镜头|所有镜头|始终).{0,32}(?:同一人物|同一角色|同一张脸)|(?:same\s+person|same\s+character|same\s+face).{0,32}(?:throughout|across\s+(?:all\s+)?shots?|in\s+every\s+shot)/iu.test(
      lock,
    );
  const hasAntiDrift =
    /(?:禁止|不得|不可|不要).{0,100}(?:网红脸|通用脸|五官|脸型|年龄感|肤色|发型|体型|身材|服装|配饰).{0,30}(?:改变|漂移|跳变|替换|美化|重塑)|(?:no|do\s+not|must\s+not).{0,100}(?:generic\s+face|beautif|face|facial\s+proportion|age|skin\s*tone|hair|body|wardrobe).{0,40}(?:change|drift|shift|replace|redesign)/iu.test(
      lock,
    );
  if (!hasSamePersonLock || !hasAntiDrift) {
    issues.push(
      `${CHARACTER_IDENTITY_LOCK_ISSUE_PREFIX}缺少跨镜头同一人物与防通用脸、防五官/发型/体型/服装漂移约束`,
    );
  }
  return issues;
}

export function isProductIdentityResponsibility(content: string): boolean {
  return /(?:产品|商品|包装|瓶身|盒身|机身|设备|实物).{0,18}(?:外观|身份|造型|结构|比例|颜色|配色|材质|部件|细节|文字|标识|logo|品牌|包装)|(?:外观|身份|造型|结构|比例|颜色|配色|材质|部件|细节|文字|标识|logo|品牌|包装).{0,18}(?:产品|商品|瓶身|盒身|机身|设备|实物)|(?:product|packaging).{0,24}(?:identity|appearance|shape|proportion|structure|color|detail|text|logo|label)/i.test(
    content,
  );
}

export function hasStrongProductFidelityLanguage(
  content: string,
  reference: string,
): boolean {
  if (!content.includes(reference)) return false;
  const hasVisibleIdentity =
    /(?:产品|商品|包装|瓶身|盒身|机身|设备|实物).{0,100}(?:外观|轮廓|造型|结构|比例|配色|颜色|材质|部件|接口|按键|镜头模组|包装)|(?:product|packaging).{0,100}(?:appearance|silhouette|shape|structure|proportion|color|material|part|button|port)/i.test(
      content,
    );
  const hasHardLock =
    /(?:严格|唯一|始终|全片).{0,60}(?:依据|基准|一致|保持|不变)|(?:不得|禁止)(?:擅自)?(?:改变|改动|改款|改色|替换|重设计)|(?:strictly|exactly|unchanged|consistent|must\s+match)/i.test(
      content,
    );
  const hasTextLock =
    /(?:文字|文案|产品名|品牌名|logo|标识|标签|包装字样|字体).{0,100}(?:一致|保持|不变|保留|逐字|不得|禁止|不可)|(?:text|copy|product\s*name|brand\s*name|logo|label|typography).{0,100}(?:match|unchanged|preserve|do\s+not|must\s+not)/i.test(
      content,
    );
  const hasAntiDrift =
    /(?:不得|禁止|不可).{0,100}(?:变形|改款|改色|增删部件|错字|乱码|镜像字|反转文字|替换文字|新增文字|虚构标签|包装变形)|(?:no|do\s+not|must\s+not).{0,100}(?:deform|redesign|recolor|misspell|gibberish|mirror|reverse|invent|replace)/i.test(
      content,
    );
  return hasVisibleIdentity && hasHardLock && hasTextLock && hasAntiDrift;
}

/**
 * Restore the minimum executable real-product lock when a final model repair
 * weakens it. References passed here were already classified as product truth
 * by the validated upload plan, so no unseen product detail is invented.
 */
export function ensureStrongProductFidelityLanguage(
  content: string,
  references: readonly string[],
): string {
  const missing = [...new Set(references.map((item) => item.trim()).filter(Boolean))]
    .filter((reference) => !hasStrongProductFidelityLanguage(content, reference));
  if (missing.length === 0) return content;
  const locks = missing.map(
    (reference) =>
      `${reference}是全片真实产品外观的唯一基准：严格保持原图中产品的轮廓、比例、结构、部件布局、配色、材质、包装、Logo位置和全部可见文字，始终为同一款产品；禁止改款、改色、增删部件、结构或包装变形、Logo漂移、错字、乱码、镜像字、反转文字、替换或新增文案；其他素材如有冲突，一律以${reference}为准。`,
  );
  return ["真实产品锁定：", ...locks, "", content.trimStart()].join("\n");
}

export function hasSafeCleanProductGenerationLanguage(content: string): boolean {
  const hasCleanupGoal =
    /(?:干净|纯净|简洁|中性|白色|去除杂乱|清理背景|棚拍|产品展示|packshot|clean|neutral|plain|studio|remove\s+clutter)/i.test(
      content,
    );
  const hasSourceFidelity =
    /(?:严格|忠实|仅以|保持).{0,80}(?:附图|原图|参考图|产品|外观|结构|比例|配色|包装)|(?:strictly|faithfully|preserve|match).{0,80}(?:source|reference|product|appearance|structure|proportion|packaging)/i.test(
      content,
    );
  const forbidsInvention =
    /(?:不得|禁止|不可).{0,100}(?:发明|猜造|臆造|重设计|改款|改色|增删部件|Logo|文字|包装|标签)|(?:do\s+not|must\s+not|no).{0,100}(?:invent|guess|redesign|recolor|add|remove|logo|text|copy|packaging|label)/i.test(
      content,
    );
  return hasCleanupGoal && hasSourceFidelity && forbidsInvention;
}

const TIMELINE_RANGE_PATTERN =
  /\d+(?:\.\d+)?\s*(?:[–—~-]|至|到)\s*\d+(?:\.\d+)?\s*(?:秒|s(?=\s|[：:，。,.;；]|$))/giu;
const QUOTED_CONTENT_PATTERN = /[“"]([^”"]+)[”"]/gu;
const LATIN_SPEECH_WORD_PATTERN = /[A-Za-z]+(?:['’-][A-Za-z]+)*/gu;

export interface ShortViralPromptComplexity {
  timelineBeats: number;
  spokenLatinWords: number;
  issues: string[];
}

export type PromptTimingMode = "viral" | "imitation" | "replication" | "free";

export interface PromptTemporalInspection {
  timedSections: number;
  microSections: number;
  issues: string[];
}

export const REPLICATION_LOCK_TYPES = [
  "action_order",
  "relative_position",
  "camera_position",
  "camera_motion",
  "pacing",
  "gesture_contact",
  "sound_cue",
  "end_state",
] as const;

export type ReplicationLockType = (typeof REPLICATION_LOCK_TYPES)[number];

export interface PromptQualityHook {
  timeRange: string;
  visibleEvent: string;
  curiosityGap: string;
  payoffTimeRange: string;
  promptAnchor: string;
}

export interface PromptQualityStoryBeat {
  order: number;
  timeRange: string;
  visibleEvent: string;
  narrativeFunction: string;
  causedBy: string;
  productRole: string;
  promptAnchor: string;
}

export interface PromptQualityMechanismMapping {
  order: number;
  sourceMechanism: string;
  targetTimeRange: string;
  targetVisibleEvent: string;
  productRole: string;
  promptAnchor: string;
}

export interface PromptQualityReplicationLock {
  lockType: ReplicationLockType;
  sourceTimeRange: string;
  targetTimeRange: string;
  instruction: string;
  promptAnchor: string;
}

export interface PromptQualityPlan {
  hook: PromptQualityHook;
  storyBeats: PromptQualityStoryBeat[];
  mechanismMappings: PromptQualityMechanismMapping[];
  replicationLocks: PromptQualityReplicationLock[];
}

export interface PromptQualityInspectionOptions {
  mode: "viral" | "imitation" | "replication" | "free";
  durationSeconds: number;
  viralCore: string[];
  promptContent: string;
  requirePromptAnchors: boolean;
}

interface ParsedTimeRange {
  start: number;
  end: number;
}

export function parsePromptTimeRange(value: string): ParsedTimeRange | null {
  const clock = /(\d{1,2}):(\d{2}(?:\.\d+)?)\s*(?:[–—~-]|至|到)\s*(\d{1,2}):(\d{2}(?:\.\d+)?)/iu.exec(
    value,
  );
  const numeric = /(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*(?:[–—~-]|至|到)\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?/iu.exec(
    value,
  );
  if (!clock && !numeric) return null;
  const start = clock
    ? Number(clock[1]) * 60 + Number(clock[2])
    : Number(numeric?.[1]);
  const end = clock
    ? Number(clock[3]) * 60 + Number(clock[4])
    : Number(numeric?.[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return null;
  }
  return { start, end };
}

export type ReferenceDecisionMode =
  | "ORIGINAL"
  | "VIRAL_ADAPTATION"
  | "CONTENT_IMITATION"
  | "STRICT_REPLICATION"
  | "REPAIR";

const KEEP_DECISION_PATTERN = /(?:^|[\n。；;])\s*(?:保留|继续沿用|保持)\s*[：:]/iu;
const CHANGE_DECISION_PATTERN = /(?:^|[\n。；;])\s*(?:改成|修改|替换|重写)\s*[：:]/iu;
const IGNORE_DECISION_PATTERN = /(?:^|[\n。；;])\s*(?:不照搬|忽略|不要复制|不参考)\s*[：:]/iu;

function finishDecisionSentence(value: string): string {
  const trimmed = value.trim().replace(/[。；;]+$/u, "");
  return trimmed ? `${trimmed}。` : "";
}

function defaultReferenceExclusions(mode: ReferenceDecisionMode): string {
  if (mode === "STRICT_REPLICATION") {
    return "原片人物身份、脸、品牌、字幕、水印和用户明确要求替换的外观；动作顺序、人物相对位置、机位、运镜、节奏、关键接触、声音落点与尾帧状态不在忽略范围内";
  }
  if (mode === "CONTENT_IMITATION") {
    return "原片人物身份、品牌、字幕、水印、精确手部路径、偶然瑕疵和逐帧机位坐标";
  }
  if (mode === "VIRAL_ADAPTATION") {
    return "原片人物身份、品牌、台词、具体动作顺序和独特镜头组合，只迁移已经说清的注意力与说服机制";
  }
  if (mode === "REPAIR") {
    return "失败成片里的身份漂移、错误动作、错误文字、断裂镜头和用户指出的偏差";
  }
  return "参考片原有剧情、人物身份、品牌、台词、动作顺序和镜头组合，只使用用户明确指定的视觉特征";
}

/**
 * Make the employee confirmation useful: every reference-led task says what
 * remains, what changes, and what must not leak into the target. This is a
 * deterministic presentation repair; it preserves the model's actual plan.
 */
export function ensureReferenceDecisionFramework(
  adaptation: string,
  viralCore: readonly string[],
  mode: ReferenceDecisionMode,
): string {
  const original = adaptation.trim();
  const hasKeep = KEEP_DECISION_PATTERN.test(original);
  const hasChange = CHANGE_DECISION_PATTERN.test(original);
  const hasIgnore = IGNORE_DECISION_PATTERN.test(original);
  if (hasKeep && hasChange && hasIgnore) return original;

  const keep = viralCore.map((item) => item.trim()).filter(Boolean).join("；");
  if (!hasKeep && !hasChange && !hasIgnore) {
    return [
      `保留：${finishDecisionSentence(keep || "用户明确指定的核心创作要求")}`,
      `改成：${finishDecisionSentence(original || "按用户要求完成目标人物、产品、场景与表达")}`,
      `不照搬：${finishDecisionSentence(defaultReferenceExclusions(mode))}`,
    ].join("\n");
  }

  return [
    !hasKeep ? `保留：${finishDecisionSentence(keep || "用户明确指定的核心创作要求")}` : "",
    original,
    !hasChange
      ? "改成：按当前方案把人物、产品、场景或表达替换为用户指定内容，具体动作与镜头以确认后的时间轴为准。"
      : "",
    !hasIgnore ? `不照搬：${finishDecisionSentence(defaultReferenceExclusions(mode))}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Accepts harmless formatting differences such as `0–1秒` versus
 * `0.00–1.00 秒`, while still requiring the same numeric interval to appear
 * in the final Seedance prompt.
 */
export function promptContainsTimeRange(
  content: string,
  expectedTimeRange: string,
): boolean {
  const expected = parsePromptTimeRange(expectedTimeRange);
  if (!expected) return content.includes(expectedTimeRange.trim());

  const ranges: ParsedTimeRange[] = [];
  for (const match of content.matchAll(
    /(\d{1,2}):(\d{2}(?:\.\d+)?)\s*(?:[–—~-]|至|到)\s*(\d{1,2}):(\d{2}(?:\.\d+)?)/giu,
  )) {
    ranges.push({
      start: Number(match[1]) * 60 + Number(match[2]),
      end: Number(match[3]) * 60 + Number(match[4]),
    });
  }
  for (const match of content.matchAll(
    /(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*(?:[–—~-]|至|到)\s*(\d+(?:\.\d+)?)\s*(?:秒|s\b)/giu,
  )) {
    ranges.push({ start: Number(match[1]), end: Number(match[2]) });
  }
  for (const range of ranges) {
    const { start, end } = range;
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      Math.abs(start - expected.start) < 0.01 &&
      Math.abs(end - expected.end) < 0.01
    ) {
      return true;
    }
  }
  return false;
}

function hasConcreteVisibleAction(value: string): boolean {
  const text = value.trim();
  if (text.length < 8) return false;
  if (
    /^(?:人物|角色|镜头)?(?:拿起|举起|展示|呈现|出现|进入)?(?:一款|这个|同一)?(?:产品|商品|包装)(?:给镜头|向镜头)?(?:展示)?[。.]?$/iu.test(
      text,
    )
  ) {
    return false;
  }
  const hasObservableVerb =
    /(?:冲|撞|裂|压|挤|泵|倒|滴|流|涂|抹|揉|擦|洗|冲净|撕|掀|翻|打开|合上|抬|抓|指|推|拉|转|退|进|跑|走|站|坐|蹲|跳|摔|伸|靠|倾|睁|闭|皱|笑|张嘴|贴近|移开|出现|进入|入画|穿过|切到|定格|变成|对比|揭开|喷出|弹出|亮起|熄灭|看向|说出|递给|拿起|放下|咬|吞|砸|破开|放大|缩小|推进|后退|摇镜|跟拍|环绕|停住|抛出|接住|滑过|旋转|折叠|展开|滴落|起泡|冲洗|按压|触摸|举起|展示|显示|掉落|滚动|晃动|倾倒|扣上|拔出|插入|贴上|撕下|擦掉|变色|显现|消失|溢出|洒出|堵住|堵塞|卡住|塞满|堆积|聚集|附着|黏住|粘住|覆满|布满|起屑|脱落|浮起|松动|冲散|扫开|带走|散开|融开|拥堵|holds?|opens?|closes?|pumps?|pours?|drops?|slides?|turns?|moves?|cuts?|reveals?|shows?|washes?|rinses?|points?|looks?|speaks?|runs?|walks?|stands?|sits?|crouches?|leans?|smiles?|jumps?|falls?|pushes?|pulls?|zooms?|tracks?|rotates?|spills?|rolls?|shakes?|inserts?|removes?|appears?|disappears?|clogs?|blocks?|piles?\s+up|builds?\s+up|sticks?|loosens?|lifts?\s+away|washes?\s+away)/iu.test(
      text,
    );
  if (hasObservableVerb) return true;

  // A repair draft can describe a filmable state change without using one of
  // the preferred verbs. Accept it only when both a concrete subject/object
  // and an observable spatial, visual or state change are present; aesthetic
  // slogans such as “营造高级感” still fail.
  const hasConcreteSubject =
    /(?:人物|角色|手|手臂|脸|眼|嘴|脚|脚跟|皮肤|产品|商品|包装|瓶|盒|泵头|标签|液体|泡沫|水|污渍|台面|地面|镜头|画面|person|character|hand|arm|face|eye|mouth|foot|heel|skin|product|package|bottle|box|pump|label|liquid|foam|water|surface)/iu.test(
      text,
    );
  const hasObservableChange =
    /(?:左|右|前|后|上|下|内|外|中央|近|远|满|空|干|湿|开|关|亮|暗|红|白|黑|透明|覆盖|露出|分开|合并|从.+到|由.+变|前后|left|right|front|back|above|below|inside|outside|near|far|full|empty|wet|dry|bright|dark|covered|visible|from.+to)/iu.test(
      text,
    );
  return hasConcreteSubject && hasObservableChange;
}

function hasPhoneReadableHookEvent(value: string): boolean {
  if (!hasConcreteVisibleAction(value)) return false;
  return /(?:突然|立即|被|打断|阻止|停止|停住|松开|离开|掉落|滑落|破开|裂开|弹出|喷出|溢出|倒下|摔倒|撞|冲|抢|接住|显现|消失|变色|亮起|熄灭|露出|揭开|翻开|挤出|泵出|堆起|覆盖|后退|回头|转头|贴近镜头|指向镜头|直视镜头|堵住|堵塞|卡住|塞满|堆积|聚集|附着|黏住|粘住|覆满|布满|起屑|脱落|浮起|松动|冲散|扫开|带走|散开|拥堵|踉跄|扶住|扶膝|抓挠|挠|从.+(?:到|变成)|由.+(?:到|变成)|sudden|interrupt|stop|drop|fall|crack|burst|spill|reveal|appear|disappear|change|clog|block|pile\s+up|build\s+up|stick|loosen|lift\s+away|wash\s+away|turns?\s+(?:red|white|dark|bright)|backs?\s+away|looks?\s+back|toward\s+the\s+camera)/iu.test(
    value,
  );
}

function normalizeCreativeClause(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s，。；：、,.!?！？“”"'‘’()（）\[\]【】_-]+/gu, "")
    .trim();
}

function hasConcreteCause(value: string): boolean {
  const text = value.trim();
  if (text.length < 6) return false;
  return !(
    /^(?:第?\d+拍|上一拍|前一拍|上一段|前一段|开场|剧情|情节)(?:留下的)?(?:问题|结果|动作|对话|需要)?$/iu.test(text) ||
    /(?:为了|用于|用来)?(?:推进剧情|推动剧情|承接上一段|承接上一拍|增强吸引力|增加戏剧性|营造氛围|保持节奏|完成过渡|自然过渡|剧情需要)/iu.test(text) ||
    /(?:to\s+move\s+the\s+story\s+forward|for\s+dramatic\s+effect|to\s+keep\s+attention|to\s+transition)/iu.test(text)
  );
}

function hasConcreteProductRole(value: string): boolean {
  const text = value.trim();
  if (text.length < 4 || isEmptyProductRole(text)) return false;
  return !(
    /^(?:展示|露出|出现|呈现|带出)?(?:产品|商品|包装)(?:即可|本身)?$/iu.test(text) ||
    /^(?:让|使)?(?:产品|商品|包装)(?:出现|露出|入画|被展示|成为焦点|更吸引人|更高级|更醒目)(?:即可|本身)?$/iu.test(text) ||
    /^(?:突出|强化|增加)(?:产品|商品|品牌)(?:展示|记忆|存在感|吸引力)$/iu.test(text)
  );
}

const REPLICATION_LOCK_SEMANTICS: Readonly<
  Record<ReplicationLockType, RegExp>
> = {
  action_order:
    /(?:先|再|随后|然后|接着|依次|顺序|开场|中段|结尾|进入|退出|拿起|放下|抬手|转身|问|答|→)/iu,
  relative_position:
    /(?:左|右|前景|后景|后方|前方|近处|远处|内侧|外侧|中间|同框|站位|位置|相对|交换|left|right|foreground|background|behind|beside)/iu,
  camera_position:
    /(?:机位|正面|侧面|背面|俯拍|仰拍|平视|高度|视线|近景|中景|远景|特写|胸口|眼睛|camera|front|side|overhead|low[- ]angle|eye[- ]level|close[- ]up|wide shot)/iu,
  camera_motion:
    /(?:固定|不推拉|不摇移|不切镜|推近|拉远|摇镜|平移|跟拍|环绕|手持|微动|变焦|运镜|static|locked|push|pull|pan|tilt|track|orbit|handheld|zoom)/iu,
  pacing:
    /(?:\d+(?:\.\d+)?\s*(?:秒|s\b)|前三秒|开场|中段|后半|结尾|停顿|加速|减速|节拍|重拍|短句|长句|轮流|交替|节奏|pause|beat|pace|rapid|slow)/iu,
  gesture_contact:
    /(?:手|掌|指|爪|腕|臂|触碰|接触|不接触|握|抓|拿|递|推|拉|拍|抱|捏|摊|抬|gesture|hand|finger|touch|contact|grip|hold|pass)/iu,
  sound_cue:
    /(?:台词|对白|问句|回答|声音|音效|环境声|音乐|重读|停顿|口型|落点|说|喊|笑声|voice|dialogue|line|sound|sfx|music|pause|stress|lip)/iu,
  end_state:
    /(?:结尾|尾帧|最后|最终|定格|停住|保持|同框|站位|看向|抬手|坐|站|躺|画面|end|final|hold|freeze|pose|frame)/iu,
};

function hasConcreteReplicationLock(
  lockType: ReplicationLockType,
  clause: string,
): boolean {
  const combined = clause.trim();
  const genericOnly =
    /^(?:(?:严格|完全|继续|始终)?(?:按照|按|跟随|参照|参考|复刻)?(?:原片|原视频|参考视频)?(?:保持|做到|执行)?(?:完全|高度)?(?:一致|相同|原样|原顺序|可观察顺序和落点)[，。；,.\s]*)+$/iu.test(
      combined,
    ) ||
    /^(?:strictly\s+)?(?:follow|match)(?:\s+the)?\s+(?:source|reference)\s+video(?:\s+and\s+(?:stay|remain)\s+consistent)?[.\s]*$/iu.test(
      combined,
    );
  if (genericOnly || !REPLICATION_LOCK_SEMANTICS[lockType].test(combined)) {
    return false;
  }
  const specificity: Readonly<Record<ReplicationLockType, RegExp>> = {
    action_order:
      /(?:先|开场).{0,80}(?:再|随后|然后|接着|最后|结尾|→).{0,80}(?:入画|退|转|抬|拿|放|推|拉|问|答|回应|停|站|坐|走|跑|跳|看|说)|(?:first|then|after|finally).{0,120}(?:enter|exit|turn|raise|take|put|push|pull|ask|answer|respond|stop|stand|sit|walk|run|jump|look|speak)/iu,
    relative_position:
      /(?:角色|人物|男|女|A|B).{0,40}(?:左|右|前景|后景|前方|后方|中间|同框).{0,80}(?:角色|人物|男|女|A|B|画面|距离)|(?:character|person|man|woman|A|B).{0,40}(?:left|right|foreground|background|behind|beside).{0,80}(?:character|person|man|woman|A|B|frame|distance)/iu,
    camera_position:
      /(?:正面|侧面|背面|俯拍|仰拍|平视|眼高|胸口高度|近景|中景|远景|特写|过肩|肩后|front|side|overhead|low[- ]angle|eye[- ]level|close[- ]up|medium shot|wide shot|over[- ]the[- ]shoulder)/iu,
    camera_motion:
      /(?:固定|不推拉|不摇移|不切镜|推近|拉远|摇镜|平移|跟拍|环绕|手持微动|变焦|static|locked|push|pull|pan|tilt|track|orbit|handheld|zoom)/iu,
    pacing:
      /(?:\d+(?:\.\d+)?\s*(?:秒|s\b)|前三秒|停顿\s*\d|重拍|短句|长句|轮流|交替|pause\s+for|on\s+the\s+beat|at\s+\d)/iu,
    gesture_contact:
      /(?:左手|右手|手掌|手指|爪|腕|手臂|身体).{0,45}(?:触碰|接触|不接触|握|抓|拿|递|推|拉|拍|抱|捏|摊|抬|指)|(?:left|right)?\s*(?:hand|palm|finger|arm|body).{0,45}(?:touch|contact|grip|hold|pass|push|pull|point|raise)/iu,
    sound_cue:
      /(?:台词|对白|问句|回答|音效|环境声|音乐|笑声|碰撞声|拍手声|喷洒声|说|喊).{0,70}(?:秒|同步|同时|落在|结束|停顿|重拍|动作)|(?:dialogue|line|sound|sfx|music|voice|laugh|impact|clap).{0,70}(?:second|sync|same time|ends?|pause|beat|action)/iu,
    end_state:
      /(?:结尾|尾帧|最后|最终).{0,100}(?:角色|人物|产品|道具|左|右|前|后|站|坐|蹲|抬手|看向|同框|定格|停住|保持|画面)|(?:end|final)\s+(?:state|frame|pose).{0,100}(?:character|person|product|prop|left|right|front|back|stand|sit|look|hold|freeze|frame)/iu,
  };
  return specificity[lockType].test(combined);
}

function anchorIsUsable(anchor: string): boolean {
  const length = anchor.trim().length;
  return length >= 6 && length <= 220;
}

const PURPOSEFUL_CAMERA_PATTERN =
  /(?:固定机位|锁定机位|正面机位|侧面机位|高机位|低机位|眼高机位|平视|俯拍|仰拍|近景|中景|全景|远景|特写|过肩|肩后|主观镜头|推近|拉远|摇镜|平移|跟拍|环绕|手持微动|变焦|对焦|焦点从|景深|一镜到底|连续单镜头|static|locked[- ]off|eye[- ]level|close[- ]up|medium shot|wide shot|overhead|low[- ]angle|push(?:es)? in|pull(?:s)? back|pan(?:s)?|tilt(?:s)?|track(?:s)?|orbit(?:s)?|handheld|zoom(?:s)?|rack focus|one[- ]take)/iu;
const CONTINUITY_STRATEGY_PATTERN =
  /(?:一镜到底|连续单镜头|不切镜|无切镜|镜头不中断|保持轴线|不越轴|180度轴线|视线匹配|动作匹配|匹配剪辑|动作接点.{0,80}连续|轴线.{0,80}连续|运动方向保持|入画方向|出画方向|屏幕左|屏幕右|接上一动作|承接上一动作|从同一动作|同一动作状态|位置连续|站位连续|手位连续|产品位置连续|道具位置连续|光线连续|空间关系连续|精确最后一帧|首尾无跳变|无缝继续|same axis|180[- ]degree rule|eyeline match|match on action|screen direction|enters? from|exits? to|position continuity|prop continuity|continuous take|without cuts?|seamless continuation)/iu;
export const MISSING_CONTINUITY_STRATEGY_ISSUE =
  "正式提示词缺少单镜头路径或多镜头连续性策略";
const EMPTY_STYLE_WORD_PATTERN =
  /(?:高级感|电影感|大片感|氛围感|视觉冲击|极致质感|高级质感|唯美感|梦幻感|震撼感|精致感|丝滑运镜|cinematic feel|premium feel|epic feel|visual impact)/giu;

/** Rejects camera jargon without an executable shot or a visual continuity line. */
export function inspectPromptCinematography(content: string): string[] {
  const issues: string[] = [];
  if (!PURPOSEFUL_CAMERA_PATTERN.test(content)) {
    issues.push("正式提示词缺少可执行的景别、机位、角度、运动或固定方式");
  }
  if (!CONTINUITY_STRATEGY_PATTERN.test(content)) {
    issues.push(MISSING_CONTINUITY_STRATEGY_ISSUE);
  }
  const emptyStyleWords = Array.from(content.matchAll(EMPTY_STYLE_WORD_PATTERN)).length;
  if (emptyStyleWords >= 5) {
    issues.push("正式提示词堆砌了过多没有画面落点的审美形容词");
  }
  return issues;
}

/**
 * Repairs a mechanical omission without asking the employee to rerun video
 * analysis or spending another model call. The sentence is deliberately
 * executable: it names the continuity invariants Seedance must preserve.
 */
export function ensurePromptContinuityStrategy(content: string): string {
  if (CONTINUITY_STRATEGY_PATTERN.test(content)) return content;
  const trimmed = content.trim();
  const continuity =
    "镜头连续性：多镜头切换只发生在动作接点；保持空间轴线、人物左右站位、视线方向、入出画方向、手位和产品位置连续，下一镜承接上一镜末尾动作，不跳轴、不瞬移。";
  return trimmed ? `${trimmed}\n\n${continuity}` : continuity;
}

const TIMED_SECTION_PATTERN =
  /(?:^|[\n。！？.!?])\s*(\d+(?:\.\d+)?)\s*(?:[–—~-]|至|到)\s*(\d+(?:\.\d+)?)\s*(?:秒|s\b)\s*[：:,，]/gimu;
const UNRESOLVED_DIRECTION_PATTERNS: readonly RegExp[] = [
  /(?:可以考虑|可考虑|也可以|可选择|任选|二选一|视情况|根据情况|根据生成效果|由模型决定|自由发挥|待定|稍后决定)/iu,
  /(?:to\s+be\s+confirmed|choose\s+either|either\s+option|optionally|if\s+desired|depending\s+on\s+the\s+result|let\s+the\s+model\s+decide)/iu,
];

function meaningfulDecimalPlaces(raw: string): number {
  const fraction = raw.split(".")[1]?.replace(/0+$/u, "") ?? "";
  return fraction.length;
}

/**
 * Timestamps are useful controls, but a final prompt must not become a
 * stopwatch grid without a narrative reason. Original and viral work use a
 * few causal macro phases; source-evidenced strict replication may remain
 * substantially more granular.
 */
export function inspectPromptTemporalClarity(
  content: string,
  durationSeconds: number,
  mode: PromptTimingMode,
): PromptTemporalInspection {
  const sections = new Map<
    string,
    { start: number; end: number; rawStart: string; rawEnd: string }
  >();
  const sectionOccurrences = new Map<string, number>();
  for (const match of content.matchAll(TIMED_SECTION_PATTERN)) {
    const rawStart = String(match[1]);
    const rawEnd = String(match[2]);
    const start = Number(rawStart);
    const end = Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const key = `${start}-${end}`;
    sections.set(key, { start, end, rawStart, rawEnd });
    sectionOccurrences.set(key, (sectionOccurrences.get(key) ?? 0) + 1);
  }

  const values = [...sections.values()];
  const microSections = values.filter(
    (section) => section.end - section.start <= 1.25,
  ).length;
  const issues: string[] = [];
  if (durationSeconds > 0 && durationSeconds <= 15 && mode !== "replication") {
    const maximumSections = mode === "imitation" ? 8 : 5;
    if (values.length > maximumSections) {
      issues.push(
        `15秒成片被切成${values.length}个时间段；请合并为不超过${maximumSections}个有因果关系的叙事阶段`,
      );
    }
    if (values.length >= 5 && microSections >= 3) {
      issues.push("时间轴出现连续的一秒级碎切；仅保留真正承担钩子、动作落点或转场的短段");
    }
    if ([...sectionOccurrences.values()].some((count) => count > 1)) {
      issues.push("同一时间段被重复写成多个段落；每段只保留一句主动作，其余控制并入同段");
    }
    if (
      values.some(
        (section) =>
          meaningfulDecimalPlaces(section.rawStart) > 1 ||
          meaningfulDecimalPlaces(section.rawEnd) > 1,
      )
    ) {
      issues.push("非严格复刻提示词使用了无来源的百分之一秒时间精度；改用整秒或最多一位小数的阶段边界");
    }
  }
  return { timedSections: values.length, microSections, issues };
}

/** Reject recommendations and unresolved branches from a paste-ready prompt. */
export function inspectPromptExecutability(content: string): string[] {
  return UNRESOLVED_DIRECTION_PATTERNS.some((pattern) => pattern.test(content))
    ? ["正式提示词仍含建议、备选方案或未决定项；改成唯一、直接、可执行的成片指令"]
    : [];
}

const PAGE_ONLY_VIDEO_CONTROL_PATTERN =
  /(?:\b(?:360|480|540|720|1080|1440|2160)[pP]\b|\b\d{3,4}\s*[x×*]\s*\d{3,4}\b|(?:^|[\s，、。：:;；])(?:9\s*:\s*16|16\s*:\s*9|1\s*:\s*1|4\s*:\s*3)(?=$|[\s，、。：:;；]|横屏|竖屏)|(?:横屏|竖屏)(?:画幅|视频)?)/iu;

/** Resolution and aspect ratio belong to the generation page, not the prompt. */
export function inspectPromptPageOnlyControls(content: string): string[] {
  return PAGE_ONLY_VIDEO_CONTROL_PATTERN.test(content)
    ? ["正式提示词混入了分辨率或画幅；这些应在生成页面选择"]
    : [];
}

/** Remove page-only controls without touching story, product or asset clauses. */
export function stripPromptPageOnlyControls(content: string): string {
  return content
    .replace(/(?:\b(?:360|480|540|720|1080|1440|2160)[pP]\b|\b\d{3,4}\s*[x×*]\s*\d{3,4}\b)/giu, "")
    .replace(
      /(?:^|[\s，、。：:;；])(?:9\s*:\s*16|16\s*:\s*9|1\s*:\s*1|4\s*:\s*3)(?=$|[\s，、。：:;；]|横屏|竖屏)/giu,
      " ",
    )
    .replace(/(?:横屏|竖屏)(?:画幅|视频)?/giu, "")
    .replace(/[  \t]{2,}/gu, " ")
    .replace(/(?:[，、]\s*){2,}/gu, "、")
    .replace(/、(?=的)/gu, "")
    .replace(/\s+，/gu, "，")
    .trim();
}

const NON_BLOCKING_FINAL_QUALITY_PATTERNS: readonly RegExp[] = [
  /^钩子不是可见的具体事件$/u,
  /^钩子缺少可执行提示词锚点$/u,
  /^正式提示词缺少单镜头路径或多镜头连续性策略$/u,
  /^正式提示词缺少可执行的景别、机位、角度、运动或固定方式$/u,
  /^正式提示词堆砌了过多没有画面落点的审美形容词$/u,
  /^15秒正式提示词过长/u,
  /^正式提示词混入了分辨率或画幅/u,
  /^15秒成片被切成/u,
  /^时间轴出现连续的一秒级碎切/u,
  /^同一时间段被重复写成/u,
  /^非严格复刻提示词使用了无来源的百分之一秒/u,
  /^短视频提示词过载：/u,
  /^正式提示词重复了第\d+个剧情节拍锚点$/u,
  /^钩子锚点必须是开场剧情节拍主句的原文片段/u,
  /^第\d+条爆点迁移锚点必须并入对应剧情节拍主句/u,
  /^第\d+条爆点迁移没有对应原理解$/u,
  /^第\d+条爆点迁移仍是空泛概念$/u,
  /^正式提示词遗漏第\d+个剧情节拍(?:的时间段)?$/u,
  /^纯文字人物身份锁/u,
];

const NON_BLOCKING_UNDERSTANDING_QUALITY_PATTERNS: readonly RegExp[] = [
  /^钩子不是可见的具体事件$/u,
  /^钩子缺少可执行提示词锚点$/u,
  /^钩子锚点必须是开场剧情节拍主句的原文片段/u,
];

/**
 * These issues reduce prompt polish but do not prove missing media, broken
 * product truth, a wrong route, or an absent story/replication structure.
 */
export function isNonBlockingFinalPromptQualityIssue(issue: string): boolean {
  return NON_BLOCKING_FINAL_QUALITY_PATTERNS.some((pattern) =>
    pattern.test(issue.trim()),
  );
}

/**
 * The first pass exposes a human-readable understanding and creates no media.
 * After bounded repairs, hidden hook metadata must not erase the whole task;
 * final production still applies the strict prompt-quality gate.
 */
export function isNonBlockingUnderstandingQualityIssue(issue: string): boolean {
  return NON_BLOCKING_UNDERSTANDING_QUALITY_PATTERNS.some((pattern) =>
    pattern.test(issue.trim()),
  );
}

/** Keep a short-video prompt direct enough that controls do not dilute each other. */
export function inspectPromptConcision(
  content: string,
  durationSeconds: number,
): string[] {
  const length = Array.from(content.trim()).length;
  if (durationSeconds > 0 && durationSeconds <= 15 && length > 2000) {
    return [
      `15秒正式提示词过长（${length}字）；合并重复锁定和同义复述，压缩到2000字以内`,
    ];
  }
  return [];
}

function exactReferencePattern(reference: string): RegExp {
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}(?!\\d)`, "u");
}

const ASSET_RESPONSIBILITY_PATTERN =
  /(?:只负责|只控制|仅负责|仅控制|唯一.{0,24}(?:基准|真值|锚点)|最高优先级.{0,24}(?:基准|真值|锚点)|controls?\s+only|sole\s+(?:source|reference|authority)|primary\s+responsibility)/iu;
const ASSET_EXCLUSION_PATTERN =
  /(?:不负责|不控制|不参考|绝不参考|不作为|冲突.{0,16}忽略|一律忽略|does\s+not\s+control|do\s+not\s+reference|must\s+not\s+control|ignore\s+conflicting)/iu;

export interface PromptAssetBinding {
  reference: string;
  coreResponsibility: string;
  doNotReference: string;
}

/** Every delivered @ asset needs a local responsibility and conflict boundary. */
export function inspectPromptAssetBindings(
  content: string,
  expectedReferences: readonly string[],
): string[] {
  const issues: string[] = [];
  const clauses = content
    .split(/[\n。；;]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (const reference of expectedReferences) {
    const pattern = exactReferencePattern(reference);
    const match = pattern.exec(content);
    if (!match || match.index === undefined) {
      issues.push(`正式提示词没有精确引用交付素材 ${reference}`);
      continue;
    }
    const start = Math.max(0, match.index - 24);
    const localClause = content.slice(start, match.index + reference.length + 320);
    if (!ASSET_RESPONSIBILITY_PATTERN.test(localClause)) {
      issues.push(`正式提示词没有写清 ${reference} 的唯一主职责`);
    }
    if (!ASSET_EXCLUSION_PATTERN.test(localClause)) {
      issues.push(`正式提示词没有写清 ${reference} 不能控制的内容`);
    }
    const responsibilityDeclarations = clauses.filter(
      (clause) =>
        exactReferencePattern(reference).test(clause) &&
        ASSET_RESPONSIBILITY_PATTERN.test(clause),
    );
    if (responsibilityDeclarations.length > 1) {
      issues.push(
        `正式提示词重复声明 ${reference} 的素材职责；只保留一个集中职责块，后文直接执行`,
      );
    }
  }
  return issues;
}

function cleanResponsibility(value: string): string {
  return value
    .trim()
    .replace(/^(?:只负责|仅负责|只控制|仅控制)\s*/u, "")
    .replace(/[。；;]+$/u, "");
}

function cleanExclusion(value: string): string {
  const cleaned = value.trim().replace(/[。；;]+$/u, "");
  if (!cleaned) return "不参考该素材职责之外的身份、动作、背景或文字";
  return ASSET_EXCLUSION_PATTERN.test(cleaned)
    ? cleaned
    : `不参考${cleaned}`;
}

/**
 * Reuse the already validated upload plan as the source of truth when a model
 * places an asset boundary too far from its first @ reference. This is a
 * deterministic layout repair: it does not invent or change creative intent.
 */
export function ensurePromptAssetBindings(
  content: string,
  bindings: readonly PromptAssetBinding[],
): string {
  const missing = bindings.filter((binding) => {
    const reference = binding.reference.trim();
    return (
      reference &&
      inspectPromptAssetBindings(content, [reference]).some((issue) =>
        issue.includes("唯一主职责") || issue.includes("不能控制的内容"),
      )
    );
  });
  if (missing.length === 0) return content;
  const lines = missing.map((binding) => {
    const responsibility = cleanResponsibility(binding.coreResponsibility);
    const exclusion = cleanExclusion(binding.doNotReference);
    return `${binding.reference.trim()}只负责${
      responsibility || "该素材在上传计划中指定的唯一职责"
    }；${exclusion}。`;
  });
  return [`素材职责：`, ...lines, "", content.trimStart()].join("\n");
}

/** Force validated immutable asset duties to the top of a rewritten prompt. */
export function forcePromptAssetBindings(
  content: string,
  bindings: readonly PromptAssetBinding[],
): string {
  const lines = bindings.flatMap((binding) => {
    const reference = binding.reference.trim();
    if (!reference) return [];
    const responsibility = cleanResponsibility(binding.coreResponsibility);
    const exclusion = cleanExclusion(binding.doNotReference);
    return [
      `${reference}只负责${
        responsibility || "该素材在上传计划中指定的唯一职责"
      }；${exclusion}。`,
    ];
  });
  if (lines.length === 0) return content;
  const block = ["素材职责：", ...lines].join("\n");
  if (content.startsWith(block)) return content;
  return [block, "", content.trimStart()].join("\n");
}

/** Replace repeated model-written responsibility lines with one trusted block. */
export function consolidatePromptAssetBindings(
  content: string,
  bindings: readonly PromptAssetBinding[],
): string {
  const references = bindings
    .map((binding) => binding.reference.trim())
    .filter(Boolean);
  if (references.length === 0) return content;
  const body = content
    .split(/\r?\n/u)
    .filter((line) => {
      if (/^\s*(?:素材职责|素材分工|asset responsibilities?)\s*[:：]?\s*$/iu.test(line)) {
        return false;
      }
      return !references.some(
        (reference) =>
          exactReferencePattern(reference).test(line) &&
          ASSET_RESPONSIBILITY_PATTERN.test(line),
      );
    })
    .join("\n")
    .replace(/^\s+|\s+$/gu, "")
    .replace(/\n{3,}/gu, "\n\n");
  return forcePromptAssetBindings(body, bindings);
}

function countExactOccurrences(content: string, fragment: string): number {
  if (!fragment) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= content.length - fragment.length) {
    const index = content.indexOf(fragment, offset);
    if (index < 0) break;
    count += 1;
    offset = index + fragment.length;
  }
  return count;
}

function isEmptyProductRole(value: string): boolean {
  return /^(?:无|没有|不涉及|不适用|none|n\/a|not applicable)$/iu.test(
    value.trim(),
  );
}

/**
 * Validates the creative substance hidden behind the employee-facing result.
 * A syntactically impressive prompt is not accepted unless its hook, causal
 * beats and mode-specific constraints map to executable prompt clauses.
 */
export function inspectPromptQualityPlan(
  plan: PromptQualityPlan,
  options: PromptQualityInspectionOptions,
): string[] {
  const issues: string[] = [];
  const duration = Math.max(1, options.durationSeconds || 15);
  const hookRange = parsePromptTimeRange(plan.hook.timeRange);
  const payoffRange = parsePromptTimeRange(plan.hook.payoffTimeRange);
  if (!hookRange || hookRange.start > 0.5 || hookRange.end > 3.2) {
    issues.push("钩子没有从开场0–3秒内发生");
  }
  if (!hasPhoneReadableHookEvent(plan.hook.visibleEvent)) {
    issues.push("钩子不是可见的具体事件");
  }
  if (plan.hook.curiosityGap.trim().length < 6) {
    issues.push("钩子没有明确的好奇缺口");
  }
  if (
    !payoffRange ||
    (hookRange && payoffRange.start < hookRange.end) ||
    payoffRange.end > duration + 0.75
  ) {
    issues.push("钩子没有在成片时间内得到偿还");
  }
  if (
    !anchorIsUsable(plan.hook.promptAnchor) ||
    !hasConcreteVisibleAction(plan.hook.promptAnchor)
  ) {
    issues.push("钩子缺少可执行提示词锚点");
  }

  const beats = plan.storyBeats;
  const minimumBeats = duration <= 6 ? 2 : 3;
  const maximumBeats =
    duration > 15
      ? 48
      : options.mode === "replication"
        ? 48
        : options.mode === "imitation"
          ? 8
          : 5;
  if (beats.length < minimumBeats || beats.length > maximumBeats) {
    issues.push(`剧情节拍数量必须为${minimumBeats}–${maximumBeats}个`);
  }
  let previousStart = -1;
  let previousEnd = 0;
  let lastEnd = 0;
  let earlyProductBeat = false;
  const beatAnchors = new Set<string>();
  const normalizedBeatEvents = new Set<string>();
  for (const [index, beat] of beats.entries()) {
    const range = parsePromptTimeRange(beat.timeRange);
    if (beat.order !== index + 1) issues.push("剧情节拍顺序不连续");
    if (
      !range ||
      range.start < previousStart ||
      range.end > duration + 0.75
    ) {
      issues.push(`第${index + 1}个剧情节拍时间无效`);
    } else {
      if (index > 0 && range.start < previousEnd - 0.05) {
        issues.push(`第${index + 1}个剧情节拍与上一拍时间重叠`);
      } else if (index > 0 && range.start > previousEnd + 0.35) {
        issues.push(`第${index + 1}个剧情节拍与上一拍之间存在时间空档`);
      }
      previousStart = range.start;
      previousEnd = range.end;
      lastEnd = Math.max(lastEnd, range.end);
      if (hasConcreteProductRole(beat.productRole) && range.start <= duration * 0.7) {
        earlyProductBeat = true;
      }
    }
    if (!hasConcreteVisibleAction(beat.visibleEvent)) {
      issues.push(`第${index + 1}个剧情节拍缺少具体可见动作`);
    }
    if (
      beat.narrativeFunction.trim().length < 4 ||
      !hasConcreteCause(beat.causedBy)
    ) {
      issues.push(`第${index + 1}个剧情节拍没有因果职责`);
    }
    const normalizedEvent = normalizeCreativeClause(beat.visibleEvent);
    if (!normalizedEvent || normalizedBeatEvents.has(normalizedEvent)) {
      issues.push(`第${index + 1}个剧情节拍重复了同一可见事件`);
    } else {
      normalizedBeatEvents.add(normalizedEvent);
    }
    const anchor = beat.promptAnchor.trim();
    if (
      !anchorIsUsable(anchor) ||
      !hasConcreteVisibleAction(anchor) ||
      beatAnchors.has(anchor)
    ) {
      issues.push(`第${index + 1}个剧情节拍锚点无效或重复`);
    } else {
      beatAnchors.add(anchor);
      if (options.requirePromptAnchors) {
        const occurrences = countExactOccurrences(options.promptContent, anchor);
        if (occurrences === 0) {
          issues.push(`正式提示词遗漏第${index + 1}个剧情节拍`);
        } else if (occurrences > 1) {
          issues.push(`正式提示词重复了第${index + 1}个剧情节拍锚点`);
        }
        if (!promptContainsTimeRange(options.promptContent, beat.timeRange)) {
          issues.push(`正式提示词遗漏第${index + 1}个剧情节拍的时间段`);
        }
      }
    }
  }
  if (beats.length > 0) {
    const firstRange = parsePromptTimeRange(beats[0].timeRange);
    if (!firstRange || firstRange.start > 0.5 || lastEnd < duration - 1) {
      issues.push("剧情节拍没有覆盖成片首尾");
    }
  }
  const hookAnchor = plan.hook.promptAnchor.trim();
  if (
    anchorIsUsable(hookAnchor) &&
    ![...beatAnchors].some(
      (beatAnchor) => beatAnchor.includes(hookAnchor) || hookAnchor === beatAnchor,
    )
  ) {
    issues.push("钩子锚点必须是开场剧情节拍主句的原文片段，不得另写一句造成复述");
  }
  if (options.mode === "viral" && !earlyProductBeat) {
    issues.push("产品没有在前70%时长内承担剧情或证明职责");
  }

  if (options.mode === "viral" || options.mode === "imitation") {
    if (plan.replicationLocks.length !== 0) {
      issues.push("爆点重构不应伪装成一比一复刻");
    }
    if (plan.mechanismMappings.length !== options.viralCore.length) {
      issues.push("已确认爆点没有逐条迁移");
    }
    let hasEarlyMapping = false;
    const mappingEvents = new Set<string>();
    const mappingAnchors = new Set<string>();
    for (const [index, mapping] of plan.mechanismMappings.entries()) {
      const range = parsePromptTimeRange(mapping.targetTimeRange);
      if (mapping.order !== index + 1) issues.push("爆点迁移顺序不连续");
      if (mapping.sourceMechanism.trim() !== (options.viralCore[index] ?? "").trim()) {
        issues.push(`第${index + 1}条爆点迁移没有对应原理解`);
      }
      if (!range || range.end > duration + 0.75) {
        issues.push(`第${index + 1}条爆点迁移时间无效`);
      } else if (range.start < 3) {
        hasEarlyMapping = true;
      }
      if (!hasConcreteVisibleAction(mapping.targetVisibleEvent)) {
        issues.push(`第${index + 1}条爆点迁移仍是空泛概念`);
      }
      if (options.mode === "viral" && !hasConcreteProductRole(mapping.productRole)) {
        issues.push(`第${index + 1}条爆点迁移没有写清产品如何参与`);
      }
      const normalizedEvent = normalizeCreativeClause(mapping.targetVisibleEvent);
      if (!normalizedEvent || mappingEvents.has(normalizedEvent)) {
        issues.push(`第${index + 1}条爆点迁移重复套用了同一事件`);
      } else {
        mappingEvents.add(normalizedEvent);
      }
      const anchor = mapping.promptAnchor.trim();
      if (!anchorIsUsable(anchor) || !hasConcreteVisibleAction(anchor)) {
        issues.push(`第${index + 1}条爆点迁移缺少提示词锚点`);
      } else if (mappingAnchors.has(normalizeCreativeClause(anchor))) {
        issues.push(`第${index + 1}条爆点迁移重复套用了同一提示词锚点`);
      } else if (
        ![...beatAnchors].some(
          (beatAnchor) => beatAnchor.includes(anchor) || beatAnchor === anchor,
        )
      ) {
        issues.push(`第${index + 1}条爆点迁移锚点必须并入对应剧情节拍主句，不得在正式提示词里另写同义复述`);
      }
      mappingAnchors.add(normalizeCreativeClause(anchor));
    }
    if (!hasEarlyMapping) issues.push("没有爆点被落实到前三秒");
  } else if (options.mode === "replication") {
    if (plan.mechanismMappings.length !== 0) {
      issues.push("一比一复刻不应输出爆点重构映射");
    }
    const actualLocks = new Set(plan.replicationLocks.map((item) => item.lockType));
    for (const lockType of REPLICATION_LOCK_TYPES) {
      if (!actualLocks.has(lockType)) issues.push(`缺少复刻硬锁：${lockType}`);
    }
    if (
      plan.replicationLocks.length !== REPLICATION_LOCK_TYPES.length ||
      actualLocks.size !== REPLICATION_LOCK_TYPES.length
    ) {
      issues.push("复刻硬锁必须八类各一条且不得重复");
    }
    const lockInstructions = new Set<string>();
    const lockAnchors = new Set<string>();
    for (const lock of plan.replicationLocks) {
      const sourceRange = parsePromptTimeRange(lock.sourceTimeRange);
      const targetRange = parsePromptTimeRange(lock.targetTimeRange);
      if (!sourceRange || !targetRange || targetRange.end > duration + 0.75) {
        issues.push(`复刻硬锁 ${lock.lockType} 的时间范围无效`);
      }
      if (
        lock.instruction.trim().length < 8 ||
        !hasConcreteReplicationLock(lock.lockType, lock.instruction)
      ) {
        issues.push(`复刻硬锁 ${lock.lockType} 缺少可执行指令`);
      }
      const anchor = lock.promptAnchor.trim();
      const normalizedInstruction = normalizeCreativeClause(lock.instruction);
      const normalizedAnchor = normalizeCreativeClause(anchor);
      if (
        !anchorIsUsable(anchor) ||
        !hasConcreteReplicationLock(lock.lockType, anchor)
      ) {
        issues.push(`复刻硬锁 ${lock.lockType} 缺少提示词锚点`);
      } else if (
        lockInstructions.has(normalizedInstruction) ||
        lockAnchors.has(normalizedAnchor)
      ) {
        issues.push(`复刻硬锁 ${lock.lockType} 与其他锁重复，八类不得共用同一句话`);
      } else if (options.requirePromptAnchors && !options.promptContent.includes(anchor)) {
        issues.push(`正式提示词遗漏复刻硬锁 ${lock.lockType}`);
      }
      lockInstructions.add(normalizedInstruction);
      lockAnchors.add(normalizedAnchor);
    }
  } else {
    if (plan.mechanismMappings.length !== 0) {
      issues.push("原创或修复任务不应伪造参考片机制映射");
    }
    if (plan.replicationLocks.length !== 0) {
      issues.push("原创或修复任务不应伪装成一比一复刻");
    }
  }
  if (options.requirePromptAnchors) {
    issues.push(...inspectPromptCinematography(options.promptContent));
  }
  return [...new Set(issues)];
}

/**
 * Rebind metadata-only hook/mechanism anchors to the already validated story
 * beat sentences after a delivery-package rewrite. This never changes the
 * prompt, story, timing, or visible action; it only repairs stale pointers.
 */
export function repairPromptQualityAnchors(
  plan: PromptQualityPlan,
  issues: readonly string[],
): PromptQualityPlan {
  const repairHookAnchor = issues.some(
    (issue) =>
      issue === "钩子缺少可执行提示词锚点" ||
      issue.startsWith("钩子锚点必须是"),
  );
  const repairHookEvent = issues.includes("钩子不是可见的具体事件");
  const mappingIndexes = new Set<number>();
  for (const issue of issues) {
    const match = /^第(\d+)条爆点迁移(?:缺少提示词锚点|锚点必须并入)/u.exec(issue);
    if (match) mappingIndexes.add(Number(match[1]) - 1);
  }
  if (!repairHookAnchor && !repairHookEvent && mappingIndexes.size === 0) {
    return plan;
  }

  const beatFor = (index: number, timeRange: string) =>
    plan.storyBeats.find((beat) => beat.timeRange.trim() === timeRange.trim()) ??
    plan.storyBeats[index];
  let changed = false;
  let hook = plan.hook;
  if (repairHookAnchor || repairHookEvent) {
    const firstBeat = beatFor(0, plan.hook.timeRange);
    if (firstBeat) {
      const nextHook = { ...plan.hook };
      if (repairHookAnchor && firstBeat.promptAnchor.trim()) {
        nextHook.promptAnchor = firstBeat.promptAnchor.trim();
      }
      if (
        repairHookEvent &&
        hasPhoneReadableHookEvent(firstBeat.visibleEvent.trim())
      ) {
        nextHook.visibleEvent = firstBeat.visibleEvent.trim();
      }
      hook = nextHook;
      changed = true;
    }
  }
  const mechanismMappings = plan.mechanismMappings.map((mapping, index) => {
    if (!mappingIndexes.has(index)) return mapping;
    const beat = beatFor(index, mapping.targetTimeRange);
    if (!beat?.promptAnchor.trim()) return mapping;
    changed = true;
    return { ...mapping, promptAnchor: beat.promptAnchor.trim() };
  });
  return changed ? { ...plan, hook, mechanismMappings } : plan;
}

/**
 * Spoken copy has a hard physical duration budget. Timeline density is exposed
 * here as a metric; inspectPromptTemporalClarity separately checks whether the
 * final paste-ready prompt was unnecessarily fragmented.
 */
export function inspectShortViralPromptComplexity(
  content: string,
  durationSeconds: number,
): ShortViralPromptComplexity {
  const timelineRanges = new Set(
    Array.from(content.matchAll(TIMELINE_RANGE_PATTERN), (match) =>
      (match[0].match(/\d+(?:\.\d+)?/g) ?? []).join("-"),
    ).filter(Boolean),
  );
  // Quality anchors and hard rules often repeat a timeline boundary verbatim.
  // Count distinct ranges, not mentions, or a focused four-beat prompt can be
  // rejected merely because it reinforces the same timing twice.
  const timelineBeats = timelineRanges.size;
  let spokenLatinWords = 0;
  for (const match of content.matchAll(QUOTED_CONTENT_PATTERN)) {
    const start = match.index ?? 0;
    const prefix = content.slice(Math.max(content.lastIndexOf("\n", start) + 1, start - 160), start);
    const speechLead = /(?:口播|旁白|画外音|对白|台词|女声|男声|童声|说(?:道|着)?|问|答|喊|讲解|voice(?:-?over)?|narration|dialogue|says?|speaks?|asks?).{0,24}[：:]?\s*$/iu.test(prefix);
    const printedLabel = /(?:包装|标签|瓶身|品名|品牌|印字|可读文字|字幕|屏幕文字|标题|大字|标语|Logo|packaging|label|on[- ]screen|caption|title|brand)/iu.test(prefix);
    // A quoted package label or on-screen title is not automatically spoken.
    if (printedLabel && !speechLead) continue;
    spokenLatinWords += Array.from(
      String(match[1] ?? "").matchAll(LATIN_SPEECH_WORD_PATTERN),
    ).length;
  }
  // Models often write `口播：English sentence` without quotation marks.
  // Count those lines too, while avoiding double-counting quoted spans.
  const speechPrefix =
    /(?:口播|旁白|画外音|台词|女声|男声|角色[^：:]{0,12}(?:说|问|答)|voice\s*over|narration|dialogue|line)\s*[：:]\s*(.+)$/iu;
  for (const line of content.split(/\n/gu)) {
    const match = speechPrefix.exec(line);
    if (match) {
      // The prefix starts BEFORE a quote, so testing its offset against the
      // quote used to count `口播：“English words”` twice. Remove quoted spans.
      const unquoted = String(match[1] ?? "").replace(QUOTED_CONTENT_PATTERN, " ");
      spokenLatinWords += Array.from(unquoted.matchAll(LATIN_SPEECH_WORD_PATTERN)).length;
    }
  }

  const issues: string[] = [];
  if (durationSeconds > 0 && durationSeconds <= 15) {
    const spokenWordBudget = Math.max(18, Math.floor(durationSeconds * 2.8));
    if (spokenLatinWords > spokenWordBudget) {
      issues.push(`英语口播超过${spokenWordBudget}词`);
    }
  }
  return { timelineBeats, spokenLatinWords, issues };
}
