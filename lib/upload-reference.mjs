/**
 * Seedance 的 @ 编号按媒体类型各自计数，而 uploadPlan.order
 * 表示所有素材共享的全局上传顺序。
 *
 * @param {string} type
 * @returns {"图片" | "视频" | "音频"}
 */
export function uploadReferenceKind(type) {
  if (type === "video") return "视频";
  if (type === "audio") return "音频";
  if (type === "image" || type === "generated") return "图片";
  throw new Error(`Unsupported upload media type: ${type}`);
}

/**
 * @param {readonly string[]} types
 * @returns {string[]}
 */
export function expectedUploadReferences(types) {
  const counts = { 图片: 0, 视频: 0, 音频: 0 };
  return types.map((type) => {
    const kind = uploadReferenceKind(type);
    counts[kind] += 1;
    return `@${kind}${counts[kind]}`;
  });
}
