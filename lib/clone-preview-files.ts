/** Only generated showroom clips are exposed; references and manifests stay private. */
export function isClonePreviewName(name: string): boolean {
  return /^(clear|focus|social|impact)-(en|es)-(female|male)-(neutral|excited|emphatic)\.mp4$/.test(name);
}

export function isVoiceAuditionName(name: string): boolean {
  return /^voice-(?:female-[1-4]|male-[1-3])\.wav$/.test(name);
}

export function isColorPreviewName(name:string):boolean {
  return /^color1-(clear|focus|social|impact)-(candy|ice|aurora|sunset)-(en|es)\.mp4$/.test(name);
}

export const CLONE_PREVIEW_VERSION = 1;
