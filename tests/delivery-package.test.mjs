import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const serviceUrl = pathToFileURL(
  path.join(projectRoot, "lib", "delivery-packages.ts"),
).href;
const dbUrl = pathToFileURL(path.join(projectRoot, "lib", "db.ts")).href;

function directorResult({ route = "VIRAL_ADAPTATION", plan = [], prompt = "成片指令" } = {}) {
  return {
    placeholder: false,
    message: "完成",
    extra: {
      director: {
        status: "ready",
        routing: { mode: route, rationale: "测试路线" },
        understanding: { title: "测试", viralCore: ["测试"], adaptation: "测试" },
        qualityPlan: {
          hook: {},
          storyBeats: [],
          mechanismMappings: [],
          replicationLocks: [],
        },
        expressionTimeline: [],
        prompts: [{ title: "最终提示词", purpose: "成片", content: prompt }],
        uploadPlan: plan,
        requiredAssets: [],
      },
    },
  };
}

function taskRow(overrides = {}) {
  return {
    id: 1,
    video_id: "video-1",
    video_name: "reference.mp4",
    feature_id: "omni_video",
    params_json: JSON.stringify({ referenceDelivery: "video_images_text" }),
    status: "succeeded",
    progress: 100,
    message: "完成",
    result_json: JSON.stringify(directorResult()),
    error: null,
    asset_schedule_complete: 1,
    created_by: "tester",
    created_at: "2026-08-21T00:00:00.000Z",
    started_at: null,
    finished_at: "2026-08-21T00:01:00.000Z",
    ...overrides,
  };
}

test("delivery packages infer actual output, switch cached data, and preserve fallback", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-package-test-"));
  const originalCwd = process.cwd();
  const originalTestDataDirectory = process.env.DW_TEST_DATA_DIR;
  process.chdir(runtimeRoot);
  process.env.DW_TEST_DATA_DIR = path.join(runtimeRoot, "data");
  try {
    const service = await import(`${serviceUrl}?test=${Date.now()}`);
    const { db } = await import(dbUrl);

    const imagePlan = [
      {
        order: 1,
        reference: "@图片1",
        assetKey: "PRODUCT_1",
        displayName: "产品图",
        type: "image",
        coreResponsibility: "产品身份",
        doNotReference: "背景",
        timeRange: "全片",
      },
    ];
    const viralImageResult = directorResult({ plan: imagePlan, prompt: "使用@图片1完成广告" });
    const base = taskRow({ result_json: JSON.stringify(viralImageResult) });
    db.prepare(
      `INSERT INTO tasks
        (id,video_id,video_name,feature_id,params_json,status,progress,message,
         result_json,error,asset_schedule_complete,created_by,created_at,finished_at)
       VALUES (?,?,?,?,?,'succeeded',100,?,?,NULL,1,?,?,?)`,
    ).run(
      base.id,
      base.video_id,
      base.video_name,
      base.feature_id,
      base.params_json,
      base.message,
      base.result_json,
      base.created_by,
      base.created_at,
      base.finished_at,
    );
    const storedBase = db.prepare("SELECT * FROM tasks WHERE id=1").get();
    const state = service.getTaskDeliveryPackageState(storedBase);
    assert.equal(state.currentMode, "images_text");
    assert.deepEqual(state.allowedModes, ["text_only", "images_text"]);

    const textResult = directorResult({ plan: [], prompt: "不引用任何附件的成片指令" });
    const now = "2026-08-21T00:02:00.000Z";
    db.prepare(
      `INSERT INTO task_delivery_packages
        (task_id,delivery_mode,status,source_result_json,result_json,error,selected,
         created_by,requested_by,created_at,started_at,finished_at,updated_at)
       VALUES (1,'text_only','succeeded',?,?,NULL,0,'tester','tester',?,NULL,?,?)`,
    ).run(JSON.stringify(textResult), JSON.stringify(textResult), now, now, now);
    const switched = service.requestDeliveryPackage({
      taskId: 1,
      targetMode: "text_only",
      actor: "tester",
    });
    assert.equal(switched.queued, false);
    assert.equal(switched.state.currentMode, "text_only");
    const selected = db
      .prepare("SELECT delivery_mode FROM task_delivery_packages WHERE task_id=1 AND selected=1")
      .get();
    assert.equal(selected.delivery_mode, "text_only");
    const switchedTask = db.prepare("SELECT params_json,result_json FROM tasks WHERE id=1").get();
    assert.equal(JSON.parse(switchedTask.params_json).referenceDelivery, "text_only");
    assert.equal(switchedTask.result_json, JSON.stringify(textResult));

    db.prepare(
      `INSERT INTO task_delivery_packages
        (task_id,delivery_mode,status,source_result_json,result_json,error,selected,
         created_by,requested_by,created_at,started_at,finished_at,updated_at)
       VALUES (1,'video_images_text','failed',?,NULL,'conversion failed',0,
               'tester','tester',?,NULL,?,?)`,
    ).run(JSON.stringify(textResult), "9999-01-01T00:00:00.000Z", now, "9999-01-01T00:00:00.000Z");
    const failedState = service.getTaskDeliveryPackageState(
      db.prepare("SELECT * FROM tasks WHERE id=1").get(),
    );
    assert.equal(failedState.currentMode, "text_only");
    assert.equal(failedState.conversion?.status, "failed");

    db.prepare(
      `UPDATE task_delivery_packages SET status='pending', updated_at=?
       WHERE task_id=1 AND delivery_mode='video_images_text'`,
    ).run(now);
    assert.throws(
      () =>
        db.prepare(
          `UPDATE task_delivery_packages SET status='pending'
           WHERE task_id=1 AND delivery_mode='images_text'`,
        ).run(),
      /UNIQUE constraint failed/,
    );

    const columns = db
      .prepare("PRAGMA table_info(task_delivery_packages)")
      .all()
      .map((column) => column.name);
    assert.ok(columns.includes("source_result_json"));
    assert.ok(columns.includes("requested_by"));
    assert.ok(columns.includes("selected"));

    const sourcePrompt = "不引用任何附件的成片指令";
    const sourceHash = createHash("sha256").update(sourcePrompt, "utf8").digest("hex");
    db.prepare(
      `INSERT INTO task_prompt_translations
        (task_id,source_hash,language,status,source_prompt,translated_prompt,error,
         created_by,requested_by,created_at,started_at,finished_at,updated_at)
       VALUES (1,?,'en','succeeded',?,'A direct, attachment-free video prompt.',NULL,
               'tester','tester',?,NULL,?,?)`,
    ).run(sourceHash, sourcePrompt, now, now, now);
    db.prepare(
      `UPDATE task_prompt_translations SET status='pending', translated_prompt=NULL
       WHERE task_id=1 AND source_hash=? AND language='en'`,
    ).run(sourceHash);

    db.close();
    const restart = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--experimental-transform-types",
        "--import",
        pathToFileURL(path.join(projectRoot, "tests", "typescript-loader.mjs")).href,
        "--input-type=module",
        "--eval",
        `const m=await import(${JSON.stringify(`${dbUrl}?restart=${Date.now()}`)});` +
          `const delivery=m.db.prepare("SELECT status,error FROM task_delivery_packages WHERE task_id=1 AND delivery_mode='video_images_text'").get();` +
          `const translation=m.db.prepare("SELECT status,error FROM task_prompt_translations WHERE task_id=1 AND language='en'").get();` +
          `process.stdout.write(JSON.stringify({delivery,translation}));m.db.close();`,
      ],
      { cwd: runtimeRoot, encoding: "utf8" },
    );
    assert.equal(restart.status, 0, restart.stderr);
    const recovered = JSON.parse(restart.stdout);
    assert.equal(recovered.delivery.status, "failed");
    assert.match(recovered.delivery.error, /服务重启/);
    assert.equal(recovered.translation.status, "failed");
    assert.match(recovered.translation.error, /服务重启/);
  } finally {
    if (originalTestDataDirectory === undefined) {
      delete process.env.DW_TEST_DATA_DIR;
    } else {
      process.env.DW_TEST_DATA_DIR = originalTestDataDirectory;
    }
    process.chdir(originalCwd);
    fs.rmSync(runtimeRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test("delivery package policy rejects route, binding, and reused-asset drift", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-package-policy-"));
  const originalCwd = process.cwd();
  process.chdir(runtimeRoot);
  try {
    const service = await import(`${serviceUrl}?policy=${Date.now()}`);
    const imagePlan = [
      {
        order: 1,
        reference: "@图片1",
        assetKey: "IMAGE_1",
        displayName: "身份图",
        type: "image",
        coreResponsibility: "人物身份",
        doNotReference: "动作",
        timeRange: "全片",
      },
    ];
    const strict = taskRow({
      result_json: JSON.stringify(
        directorResult({ route: "STRICT_REPLICATION", plan: imagePlan }),
      ),
    });
    assert.deepEqual(service.allowedModesForTask(strict), [
      "text_only",
      "images_text",
      "video_images_text",
    ]);
    assert.equal(
      service.normalizePromptAnchor("0–3秒：@图片1中的角色抬手。"),
      "03秒角色抬手",
    );

    const source = {
      routing: { mode: "STRICT_REPLICATION" },
      qualityPlan: {
        storyBeats: [{ promptAnchor: "0–3秒：@图片1中的角色抬手。" }],
        replicationLocks: [],
      },
      expressionTimeline: [],
      uploadPlan: imagePlan,
      requiredAssets: [
        {
          assetKey: "IMAGE_1",
          kind: "character_identity",
          status: "provided",
          canGenerate: false,
          generationPrompt: "",
          dependsOnAssetKeys: [],
        },
      ],
    };
    const textOutput = {
      status: "ready",
      routing: { mode: "STRICT_REPLICATION" },
      prompts: [{ content: "0–3秒：角色抬手。" }],
      uploadPlan: [],
      requiredAssets: [],
      expressionTimeline: [],
    };
    assert.doesNotThrow(() =>
      service.assertConvertedPackage(source, textOutput, "text_only"),
    );

    const videoOutput = {
      ...textOutput,
      prompts: [{ content: "0–3秒：@图片1中的角色抬手；动作参考@视频1。" }],
      uploadPlan: [
        imagePlan[0],
        {
          order: 2,
          reference: "@视频1",
          assetKey: "REFERENCE_VIDEO",
          displayName: "动作参考",
          type: "video",
          coreResponsibility: "动作与镜头",
          doNotReference: "人物身份",
          timeRange: "全片",
        },
      ],
      requiredAssets: source.requiredAssets,
    };
    assert.doesNotThrow(() =>
      service.assertConvertedPackage(source, videoOutput, "video_images_text"),
    );
    assert.throws(
      () =>
        service.assertConvertedPackage(
          source,
          {
            ...videoOutput,
            requiredAssets: [
              { ...source.requiredAssets[0], kind: "different_character" },
            ],
          },
          "video_images_text",
        ),
      /生成规格/,
    );
    const stabilized = service.stabilizeConvertedPackage(
      source,
      {
        ...videoOutput,
        uploadPlan: [
          {
            ...imagePlan[0],
            coreResponsibility: "模型改写后的职责",
            doNotReference: "模型改写后的禁止项",
          },
          videoOutput.uploadPlan[1],
        ],
        requiredAssets: [
          { ...source.requiredAssets[0], kind: "different_character" },
        ],
      },
      "video_images_text",
    );
    assert.equal(stabilized.uploadPlan[0].coreResponsibility, "人物身份");
    assert.equal(stabilized.uploadPlan[0].doNotReference, "动作");
    assert.equal(stabilized.requiredAssets[0].kind, "character_identity");
    assert.match(stabilized.prompts[0].content, /@图片1只负责人物身份/u);
    assert.doesNotThrow(() =>
      service.assertConvertedPackage(source, stabilized, "video_images_text"),
    );
    assert.throws(
      () =>
        service.assertConvertedPackage(
          source,
          { ...videoOutput, uploadPlan: [imagePlan[0]] },
          "video_images_text",
        ),
      /参考视频/,
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(runtimeRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
