// Real UI, synthetic fixtures only. No installed plugins, user data or AI calls.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../server/core.mjs';
import {startHttp} from '../server/http.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'seqivo-readme-'));
const output = resolve('docs/assets');
let core, web, browser;
try {
  await mkdir(output, {recursive: true});
  core = await createCore({dataDir: join(temporary, 'data'), pluginDir: join(temporary, 'no-plugins'), files: false});
  const project = core.store.project({name: '产品迭代 · 示例项目', goal: '从明确的目标，到经过验证的交付。'});
  const add = (title, goal, summary, example, approach, criteria) => core.store.createTask({projectId: project.id, title, goal, summary, example, approach, criteria});
  const change = (task, patch) => core.store.updateTask(task.id, patch, task.revision);
  const verify = (task, status) => core.store.verify(task.id, {
    expectedRevision: task.revision, status,
    summary: '示例记录：用于展示验证状态，不代表真实业务测试。',
    reference: 'README-DEMO · synthetic fixture',
    criterionIds: status === 'failed' ? [] : status === 'partial' ? [task.criteria[0].id] : task.criteria.map(c => c.id),
  });
  const accept = task => {
    task = change(task, {status: 'submitted'});
    task = verify(task, 'passed');
    task = core.store.addEvidence(task.id, {expectedRevision: task.revision, summary: '示例交付证据', reference: 'README-DEMO · synthetic fixture'});
    return core.store.review(task.id, {expectedRevision: task.revision, decision: 'pass', summary: '示例人工验收记录，仅用于文档展示。'});
  };

  let mobile = add('完成移动端适配', '在手机上清晰查看任务和进展。', '列表已适配，正在检查任务详情与操作回执。', '出门后，用手机查看项目还有哪些工作待完成。', '复用同一套任务视图，按屏幕宽度调整布局。', ['列表在窄屏下完整显示', '任务详情和操作回执可读']);
  mobile = change(mobile, {status: 'running', nextStep: '检查任务详情与操作回执的窄屏布局。'});
  verify(mobile, 'partial');
  let order = add('接入真实订单接口', '订单保存到服务端，刷新页面仍可查询。', '接口与持久化已提交，测试已通过，等待人工验收。', '创建一笔订单，关闭页面后重新打开，订单仍然存在。', '前端调用订单 API，服务端写入数据库；通过集成测试核对创建和查询结果。', ['通过服务端 API 创建并查询订单', '重新打开页面后，已保存的订单仍可见']);
  order = verify(change(order, {status: 'submitted'}), 'passed');
  let exporting = add('修复导出后的空白文件', '导出的文件应包含当前筛选结果。', '发现筛选条件未传入导出请求，需要补充修复。', '筛选本周订单后，导出的表格应包含相同记录。', '统一列表查询与导出请求的筛选参数。', ['导出内容与筛选结果一致']);
  exporting = verify(change(exporting, {status: 'submitted'}), 'failed');
  core.store.review(exporting.id, {expectedRevision: exporting.revision, decision: 'fail', summary: '示例偏差：页面有记录，但导出的文件为空。'});
  add('增加项目归档', '把已结束的项目收起，保持工作列表简洁。', '验收标准已明确，等待开始。', '完成的项目归档后，仍能查到任务历史。', '保留数据与历史，为项目增加归档状态。', ['归档项目可恢复', '历史记录仍可查询']);
  accept(add('保存任务和历史记录', '重新打开应用后保留进度。', '任务记录与历史恢复已验收。', '重启后继续查看上次的任务。', '将任务变化持久化并保留事件记录。', ['重启后记录保留']));
  accept(add('支持浅色与深色外观', '让看板适合白天和夜晚使用。', '两种外观与跟随系统已验收。', '夜间切换深色，重启后保留选择。', '使用统一主题变量与持久化设置。', ['外观选择可保存']));

  web = await startHttp({core, dataDir: join(temporary, 'data'), distDir: resolve('dist'), port: 0});
  browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
  const page = await browser.newPage({viewport: {width: 1440, height: 1060}, deviceScaleFactor: 1});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(token => sessionStorage.setItem('taskboard-token', token), web.tokens.owner);
  const url = `http://127.0.0.1:${web.port}`;
  await page.goto(url);
  await page.locator('.task-row').filter({hasText: order.title}).click();
  await page.getByRole('region', {name: '测试验证', exact: true}).waitFor();
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '2');
  assert.equal(await page.locator('.task-row').count(), 6);
  for (const [label, theme] of [['浅色', 'light'], ['深色', 'dark']]) {
    await page.getByRole('button', {name: label, exact: true}).click();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    await page.getByRole('button', {name: '关闭提示', exact: true}).click();
    await page.screenshot({path: join(output, `overview-${theme}.png`), animations: 'disabled'});
  }
  await page.getByRole('button', {name: '浅色', exact: true}).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.getByRole('button', {name: '关闭提示', exact: true}).click();
  await page.getByRole('navigation', {name: '主要导航'}).getByRole('button', {name: '交付偏差'}).click();
  await page.getByRole('heading', {name: '示例偏差：页面有记录，但导出的文件为空。'}).waitFor();
  await page.screenshot({path: join(output, 'delivery-review.png'), animations: 'disabled'});
  await page.getByRole('navigation', {name: '主要导航'}).getByRole('button', {name: '任务清单'}).click();
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path: join(output, 'mobile-layout.png'), animations: 'disabled'});
  await page.goto(`${url}/?floating=1`);
  await page.setViewportSize({width: 380, height: 310});
  await page.getByRole('button', {name: '收起悬浮窗'}).waitFor();
  await page.screenshot({path: join(output, 'floating-layout.png'), animations: 'disabled'});
  assert.deepEqual(errors, []);
  console.log('PASS: 5 README screenshots; real UI with synthetic data; 6 tasks / 2 accepted; no browser errors; no AI calls.');
} finally {
  await browser?.close();
  await web?.close();
  await core?.close();
  await rm(temporary, {recursive: true, force: true});
}
