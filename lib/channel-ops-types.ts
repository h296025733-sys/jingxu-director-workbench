export const OPS_CONTENT_TYPES = [
  "标签教育",
  "成分教育",
  "FAQ",
  "错误纠正",
  "生活场景",
  "办公室场景",
  "穿搭场景",
  "出门场景",
  "产品场景",
] as const;

export const OPS_STAGES = [
  "选题池",
  "待生成",
  "脚本完成",
  "剪辑中",
  "待审核",
  "待发布",
  "已发布",
] as const;

export const OPS_COMPLIANCE_STATES = ["未检查", "待复核", "已通过"] as const;

export type OpsEntityType = "store" | "account" | "item";
export type OpsChangeAction = "create" | "update" | "delete";

export interface OpsStore {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface OpsAccount {
  id: string;
  storeId: string;
  handle: string;
  displayName: string;
  prefix: string;
  focus: string;
  tone: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface OpsContentItem {
  id: string;
  accountId: string;
  contentCode: string;
  title: string;
  contentType: string;
  plannedDate: string;
  stage: string;
  compliance: string;
  owner: string;
  hook: string;
  cta: string;
  views: number;
  clicks: number;
  ordersCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface OpsWorkspaceData {
  revision: number;
  latestChangeAt: string | null;
  stores: OpsStore[];
  accounts: OpsAccount[];
  items: OpsContentItem[];
}

export interface OpsChangeLog {
  id: number;
  actorUsername: string;
  actorDisplayName: string;
  entityType: OpsEntityType;
  entityId: string;
  entityLabel: string;
  action: OpsChangeAction;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

export interface OpsHistoryPage {
  logs: OpsChangeLog[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface OpsMutationResult<T> {
  value: T;
  revision: number;
  merged: boolean;
  changed: boolean;
}
