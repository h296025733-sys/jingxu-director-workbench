import assert from "node:assert/strict";

const baseUrl = process.env.DW_E2E_BASE_URL || "http://127.0.0.1:39123";

async function login(username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "login should set a cookie");
  return setCookie.split(";", 1)[0];
}

async function request(path, { cookie, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

const adminCookie = await login("admin", "LocalFormsTest123");
const username = `forms_test_${Date.now()}`;
const createdUser = await request("/api/users", {
  cookie: adminCookie,
  method: "POST",
  body: {
    username,
    displayName: "协作表测试成员",
    password: "MemberTest123",
    isAdmin: false,
  },
});
assert.equal(createdUser.response.status, 200, JSON.stringify(createdUser.payload));
const memberCookie = await login(username, "MemberTest123");

const memberWorkspace = await request("/api/forms", { cookie: memberCookie });
assert.equal(memberWorkspace.response.status, 200);
assert.equal(memberWorkspace.payload.stores.length, 1);
assert.equal(memberWorkspace.payload.accounts.length, 2);
assert.equal(memberWorkspace.payload.items.length, 10);

const forbiddenHistory = await request("/api/forms/history", { cookie: memberCookie });
assert.equal(forbiddenHistory.response.status, 403);

const accountId = memberWorkspace.payload.accounts[0].id;
const referenceBytes = Buffer.alloc(64);
referenceBytes.write("ftyp", 4, "ascii");
referenceBytes.write("isom", 8, "ascii");
const uploadedReference = await fetch(
  `${baseUrl}/api/forms/reference-video?accountId=${encodeURIComponent(accountId)}&filename=${encodeURIComponent("account-reference.mov")}&size=${referenceBytes.length}`,
  {
    method: "PUT",
    headers: { Cookie: memberCookie, "Content-Type": "video/quicktime" },
    body: referenceBytes,
  },
);
const uploadedReferencePayload = await uploadedReference.json();
assert.equal(uploadedReference.status, 200, JSON.stringify(uploadedReferencePayload));
assert.equal(uploadedReferencePayload.video.filename, "account-reference.mov");
assert.equal(uploadedReferencePayload.video.sizeBytes, referenceBytes.length);

const referenceMetadata = await request(`/api/forms/reference-video?accountId=${encodeURIComponent(accountId)}`, { cookie: adminCookie });
assert.equal(referenceMetadata.response.status, 200, JSON.stringify(referenceMetadata.payload));
assert.equal(referenceMetadata.payload.video.filename, "account-reference.mov");

const referenceRange = await fetch(
  `${baseUrl}/api/forms/reference-video?accountId=${encodeURIComponent(accountId)}&file=1`,
  { headers: { Cookie: adminCookie, Range: "bytes=4-11" } },
);
assert.equal(referenceRange.status, 206);
assert.equal(referenceRange.headers.get("content-range"), `bytes 4-11/${referenceBytes.length}`);
assert.equal(Buffer.from(await referenceRange.arrayBuffer()).toString("ascii"), "ftypisom");

const removedReference = await request(`/api/forms/reference-video?accountId=${encodeURIComponent(accountId)}`, {
  cookie: memberCookie,
  method: "DELETE",
});
assert.equal(removedReference.response.status, 200, JSON.stringify(removedReference.payload));
assert.equal(removedReference.payload.removed, true);

const itemInput = {
  accountId,
  contentCode: "A98",
  title: "HTTP shared row",
  contentType: "FAQ",
  plannedDate: "2026-09-03",
  stage: "选题池",
  compliance: "未检查",
  owner: "Member",
  hook: "Hook",
  cta: "CTA",
  views: 0,
  clicks: 0,
  ordersCount: 0,
};
const created = await request("/api/forms", {
  cookie: memberCookie,
  method: "POST",
  body: { entity: "item", data: itemInput },
});
assert.equal(created.response.status, 200, JSON.stringify(created.payload));
const original = created.payload.value;

const adminWorkspace = await request("/api/forms", { cookie: adminCookie });
assert.equal(adminWorkspace.payload.items.some((item) => item.id === original.id), true);

const memberEdit = await request("/api/forms", {
  cookie: memberCookie,
  method: "PUT",
  body: {
    entity: "item",
    id: original.id,
    baseVersion: original.version,
    base: itemInput,
    data: { ...itemInput, stage: "剪辑中" },
  },
});
assert.equal(memberEdit.response.status, 200, JSON.stringify(memberEdit.payload));

const adminMergedEdit = await request("/api/forms", {
  cookie: adminCookie,
  method: "PUT",
  body: {
    entity: "item",
    id: original.id,
    baseVersion: original.version,
    base: itemInput,
    data: { ...itemInput, owner: "Admin" },
  },
});
assert.equal(adminMergedEdit.response.status, 200, JSON.stringify(adminMergedEdit.payload));
assert.equal(adminMergedEdit.payload.merged, true);
assert.equal(adminMergedEdit.payload.value.stage, "剪辑中");
assert.equal(adminMergedEdit.payload.value.owner, "Admin");

const merged = adminMergedEdit.payload.value;
const mergedBase = { ...itemInput, stage: merged.stage, owner: merged.owner };
const memberTitleEdit = await request("/api/forms", {
  cookie: memberCookie,
  method: "PUT",
  body: {
    entity: "item",
    id: merged.id,
    baseVersion: merged.version,
    base: mergedBase,
    data: { ...mergedBase, title: "Member wins first" },
  },
});
assert.equal(memberTitleEdit.response.status, 200, JSON.stringify(memberTitleEdit.payload));

const overlappingEdit = await request("/api/forms", {
  cookie: adminCookie,
  method: "PUT",
  body: {
    entity: "item",
    id: merged.id,
    baseVersion: merged.version,
    base: mergedBase,
    data: { ...mergedBase, title: "Admin stale title" },
  },
});
assert.equal(overlappingEdit.response.status, 409);
assert.equal(overlappingEdit.payload.code, "EDIT_CONFLICT");
assert.deepEqual(overlappingEdit.payload.fields, ["title"]);

const latest = overlappingEdit.payload.current;
const deleted = await request("/api/forms", {
  cookie: adminCookie,
  method: "DELETE",
  body: { entity: "item", id: latest.id, baseVersion: latest.version },
});
assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));

const history = await request("/api/forms/history?search=A98", { cookie: adminCookie });
assert.equal(history.response.status, 200);
assert.ok(history.payload.logs.some((log) => log.action === "create" && log.actorUsername === username));
assert.ok(history.payload.logs.some((log) => log.action === "delete" && log.actorUsername === "admin"));
const referenceHistory = await request("/api/forms/history?search=参考视频", { cookie: adminCookie });
assert.equal(referenceHistory.response.status, 200);
assert.ok(referenceHistory.payload.logs.some((log) => log.actorUsername === username && log.summary.includes("上传")));
assert.ok(referenceHistory.payload.logs.some((log) => log.actorUsername === username && log.summary.includes("移除")));

const users = await request("/api/users", { cookie: adminCookie });
const member = users.payload.users.find((user) => user.username === username);
assert.ok(member);
const removedUser = await request(`/api/users/${member.id}`, { cookie: adminCookie, method: "DELETE" });
assert.equal(removedUser.response.status, 200, JSON.stringify(removedUser.payload));

console.log(JSON.stringify({
  ok: true,
  sharedRows: true,
  memberHistoryStatus: forbiddenHistory.response.status,
  automaticMerge: adminMergedEdit.payload.merged,
  overlappingEditStatus: overlappingEdit.response.status,
  historyEntries: history.payload.logs.length,
  referenceVideoUpload: true,
}));
