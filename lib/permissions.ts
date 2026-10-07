import type { AuthUser } from "./auth";

/** 是否可以管理（删除/取消/重试）某个视频：管理员或上传者本人 */
export function canManageVideo(
  user: AuthUser,
  uploadedBy: string,
): boolean {
  return user.isAdmin || user.username === uploadedBy;
}

/** 是否可以管理（删除/取消/重试）某个任务：管理员或创建者本人 */
export function canManageTask(user: AuthUser, createdBy: string): boolean {
  return user.isAdmin || user.username === createdBy;
}
