import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SetupWizardDefaultDriver } from '../../../testing/setup-wizard-default-driver.js';

describe('SetupWizardDefaultDriver', () => {
  it('submits each completed prompt once and ignores long work between prompts', () => {
    const driver = new SetupWizardDefaultDriver();
    let output = '\u001b[1m◆  选择飞书机器人配置方式\u001b[0m\r\n│  ● 扫码创建\r\n└\r\n';

    assert.equal(driver.shouldSubmit(output), true);
    assert.equal(driver.shouldSubmit(output), false);

    output += '\u001b[999D\u001b[5A◇  选择飞书机器人配置方式\r\n│  扫码创建\r\n';
    for (let index = 0; index < 1_000; index += 1) {
      output += `等待扫码 ${index}\r\n`;
      assert.equal(driver.shouldSubmit(output), false);
    }
    assert.equal(driver.submissionCount, 1);

    output += '◆  允许的飞书 open_id\r\n│  _\r\n└\r\n';
    assert.equal(driver.shouldSubmit(output), true);
    assert.equal(driver.shouldSubmit(output), false);
    assert.equal(driver.submissionCount, 2);

    output += '◇  允许的飞书 open_id\r\n│  留空\r\n◆  选择运行时\r\n│  ● Codex\r\n└\r\n';
    assert.equal(driver.shouldSubmit(output), true);
    assert.equal(driver.submissionCount, 3);
  });

  it('does not submit a partial prompt or a redraw before the prior prompt resolves', () => {
    const driver = new SetupWizardDefaultDriver();
    let output = '◆  第一个提示\n│  ● 默认';
    assert.equal(driver.shouldSubmit(output), false);

    output += '\n└\n';
    assert.equal(driver.shouldSubmit(output), true);

    output += '◆  第一个提示\n│  ● 默认\n└\n';
    assert.equal(driver.shouldSubmit(output), false);
    assert.equal(driver.submissionCount, 1);
  });
});
