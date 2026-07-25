import type {
  OutboundCardActionSelect,
  OutboundCardActionSelectOption,
  OutboundRichCard,
  OutboundRichCardSection,
  OutboundRichCardTable,
  StreamingHistoryItem,
  TaskProgressInfo,
  ToolCallInfo,
} from '../../domain/index.js';
import type { StructuredStreamingUiMetadata } from '../contracts.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';
import { formatStreamTagLabel } from '../../shared/streaming-metadata.js';
import {
  buildToolProgressBlocks,
  buildToolProgressMarkdown,
  type FinalCardTerminalStatus,
  type ToolProgressBlock,
  type ToolProgressRenderOptions,
} from '../../shared/progress/tool-rendering.js';

export { buildToolProgressMarkdown } from '../../shared/progress/tool-rendering.js';

export interface FeishuCardActionButton {
  text: string;
  callbackData: string;
  type?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  submit?: boolean;
}

export type FeishuMarkdownTextSize = 'normal' | 'notation';

export interface FeishuToolCallCardStyle {
  outerPanel: {
    titleTextSize: FeishuMarkdownTextSize;
    borderColor: string | null;
    borderCornerRadius: string;
  };
  innerPanel: {
    titleTextSize: FeishuMarkdownTextSize;
    detailTextSize: FeishuMarkdownTextSize;
    borderColorByStatus: Record<ToolCallInfo['status'], string | null>;
    borderCornerRadius: string;
  };
}

export const DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE: FeishuToolCallCardStyle = {
  outerPanel: {
    titleTextSize: 'notation',
    borderColor: null,
    borderCornerRadius: '5px',
  },
  innerPanel: {
    titleTextSize: 'notation',
    detailTextSize: 'notation',
    borderColorByStatus: {
      running: 'yellow',
      complete: 'green',
      error: 'red',
    },
    borderCornerRadius: '5px',
  },
};

export const FEISHU_LONG_USER_INPUT_COLLAPSE_THRESHOLD = 800;
export const FEISHU_LONG_USER_INPUT_TITLE_LIMIT = 240;

function resolveTitleTagColor(
  tag: string,
  defaultColor: NonNullable<StructuredStreamingUiMetadata['tagColor']>,
): NonNullable<StructuredStreamingUiMetadata['tagColor']> {
  const normalized = tag.trim().toLowerCase();
  if (isRuntimeNameMetadataTag(normalized)) return 'orange';
  if (normalized === 'sdk' || normalized === 'source:sdk') return 'green';
  if (normalized === 'mirror' || normalized === 'source:mirror') return 'yellow';
  if (normalized.startsWith('effort:')) return 'green';
  if (normalized.startsWith('reasoning:')) return 'green';
  if (normalized.startsWith('model:')) return 'turquoise';
  return defaultColor;
}

function isRuntimeNameMetadataTag(normalized: string): boolean {
  return normalized === 'codex' || normalized === 'claude' || normalized === 'kimi' || normalized === 'cursor';
}

function isRuntimeMetadataTag(tag: string): boolean {
  const normalized = tag.trim().toLowerCase();
  if (isRuntimeNameMetadataTag(normalized)) return true;
  const prefix = normalized.split(':', 1)[0];
  return prefix === 'effort' || prefix === 'reasoning' || prefix === 'model';
}

function escapeTextTagContent(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&#60;')
    .replace(/>/g, '&#62;');
}

function metadataBodyTagColor(tag: string): 'orange' | 'green' | 'turquoise' | 'grey' {
  const normalized = tag.trim().toLowerCase();
  if (isRuntimeNameMetadataTag(normalized)) return 'orange';
  const prefix = normalized.split(':', 1)[0];
  if (prefix === 'effort' || prefix === 'reasoning') return 'green';
  if (prefix === 'model') return 'turquoise';
  return 'grey';
}

export function buildMetadataTagElements(
  metadata: StructuredStreamingUiMetadata = {},
): Array<Record<string, unknown>> {
  const runtimeTags = (metadata.tags || [])
    .map((tag) => tag.trim())
    .filter((tag) => tag && isRuntimeMetadataTag(tag));
  if (runtimeTags.length === 0) return [];
  return [{
    tag: 'markdown',
    content: runtimeTags
      .map((tag) => `<text_tag color='${metadataBodyTagColor(tag)}'>${escapeTextTagContent(tag)}</text_tag>`)
      .join(' '),
    text_align: 'left',
    text_size: 'notation',
    element_id: 'runtime_meta_tags',
  }];
}

export function buildCardTitleHeader(
  metadata: StructuredStreamingUiMetadata = {},
  options: { tagElementPrefix?: string } = {},
): Record<string, unknown> | undefined {
  const title = metadata.title?.trim();
  const tags = (metadata.tags || [])
    .map((tag) => tag.trim())
    .filter((tag) => tag && !isRuntimeMetadataTag(tag))
    .slice(0, 3);
  if (!title && tags.length === 0) return undefined;
  const tagElementPrefix = options.tagElementPrefix || 'title_tag';
  const defaultTagColor = metadata.tagColor || 'blue';
  return {
    title: {
      tag: 'plain_text',
      content: title || 'Codex',
    },
    template: metadata.template || 'blue',
    ...(tags.length > 0
      ? {
          text_tag_list: tags.map((tag, index) => ({
            tag: 'text_tag',
            element_id: `${tagElementPrefix}_${index + 1}`,
            text: {
              tag: 'plain_text',
              content: formatStreamTagLabel(tag),
            },
            color: resolveTitleTagColor(tag, defaultTagColor),
          })),
        }
      : {}),
  };
}

/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 *
 * Schema 2.0 cards render code blocks, tables, bold, italic, links properly.
 * Post messages with md tag render bold, italic, inline code, links.
 */

/**
 * Detect complex markdown (code blocks / tables).
 * Used by send() to decide between card and post rendering.
 */
export function hasComplexMarkdown(text: string): boolean {
  // Fenced code blocks
  if (/```[\s\S]*?```/.test(text)) return true;
  // Tables: header row followed by separator row with pipes and dashes
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

const EMBEDDED_CODE_FENCE_GUARD = '`\u200B``';

function escapeEmbeddedCodeFences(text: string): string {
  return text.replace(/```/g, EMBEDDED_CODE_FENCE_GUARD);
}

function isFenceLine(line: string, fenceLength: number): boolean {
  const match = /^( {0,3})(`{3,})([^`]*)$/.exec(line);
  return Boolean(match && match[2].length >= fenceLength);
}

function containsFeishuTemplateExpression(text: string): boolean {
  return text.includes('${');
}

/**
 * Feishu's card Markdown renderer flattens a fenced block when its body
 * contains a `${...}` expression, even without JavaScript backticks. Card
 * JSON 2.0 also supports CommonMark indented code blocks, which preserve the
 * body byte-for-byte without asking the client to parse that combination.
 */
function rewriteTemplateLiteralFencesAsIndentedCode(text: string): string {
  const lines = text.split('\n');
  const rendered: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^( {0,3})(`{3,})([^`]*)$/.exec(lines[index] || '');
    if (!opener) {
      rendered.push(lines[index] || '');
      continue;
    }

    const fenceLength = opener[2].length;
    let closingIndex = index + 1;
    while (closingIndex < lines.length && !isFenceLine(lines[closingIndex] || '', fenceLength)) {
      closingIndex += 1;
    }
    if (closingIndex >= lines.length) {
      rendered.push(lines[index] || '');
      continue;
    }

    const body = lines.slice(index + 1, closingIndex);
    if (!containsFeishuTemplateExpression(body.join('\n'))) {
      rendered.push(...lines.slice(index, closingIndex + 1));
      index = closingIndex;
      continue;
    }

    if (rendered.length > 0 && rendered[rendered.length - 1]?.trim()) rendered.push('');
    rendered.push(...body.map((line) => `    ${line}`));
    if (lines[closingIndex + 1]?.trim()) rendered.push('');
    index = closingIndex;
  }

  return rendered.join('\n');
}

function protectCodeFenceContents(text: string): string {
  const lines = text.split('\n');
  const rendered: string[] = [];
  let fenceLength = 0;

  for (const line of lines) {
    if (fenceLength > 0) {
      if (isFenceLine(line, fenceLength)) {
        rendered.push('```');
        fenceLength = 0;
      } else {
        rendered.push(escapeEmbeddedCodeFences(line));
      }
      continue;
    }

    const opener = /^( {0,3})(`{3,})([^`]*)$/.exec(line);
    if (opener) {
      fenceLength = opener[2].length;
      rendered.push(`${opener[1]}\`\`\`${opener[3]}`);
    } else {
      rendered.push(line);
    }
  }

  return rendered.join('\n');
}

function ensureCodeFenceStartsOnNewLine(text: string): string {
  return text.split('\n').map((line) => {
    // Four-space indented code is already a code block. Literal backticks in
    // its body must never be promoted back into Markdown fence delimiters.
    if (/^(?: {4}|\t)/u.test(line)) return line;
    return line.replace(/([^\n])```/g, '$1\n```');
  }).join('\n');
}

/**
 * Preprocess markdown for Feishu rendering.
 * Keeps ordinary fenced blocks (and their language hint) unchanged. Feishu
 * flattens fenced bodies containing `${...}`, so only those blocks fall back
 * to CommonMark's four-space indented code form.
 */
export function preprocessFeishuMarkdown(text: string): string {
  const protectedText = protectCodeFenceContents(rewriteTemplateLiteralFencesAsIndentedCode(text));
  // Ensure ``` has newline before it (unless at start of text)
  return ensureCodeFenceStartsOnNewLine(protectedText);
}

/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Renders code blocks, tables, bold, italic, links, inline code properly.
 * Aligned with Openclaw's buildMarkdownCard().
 */
export function buildCardContent(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: preprocessFeishuMarkdown(text),
        },
      ],
    },
  });
}

const DEFAULT_RICH_CARD_MAX_SECTIONS = 12;
const RICH_CARD_TITLE_LIMIT = 120;
const RICH_CARD_TEXT_LIMIT = 600;
const RICH_CARD_FIELD_LIMIT = 140;
const RICH_CARD_INLINE_FIELD_LIMIT = 3;
const RICH_CARD_SELECT_OPTION_LIMIT = 60;
const MIRROR_GOAL_COLLAPSE_THRESHOLD = 120;
const FEISHU_COLOR_ENUM_VALUES = new Set([
  'bg-white',
  'white',
  'blue',
  'carmine',
  'green',
  'grey',
  'indigo',
  'lime',
  'orange',
  'purple',
  'red',
  'sunflower',
  'turquoise',
  'violet',
  'wathet',
  'yellow',
].flatMap((color) => color === 'bg-white' || color === 'white'
  ? [color]
  : [
      color,
      `${color}-50`,
      `${color}-100`,
      `${color}-200`,
      `${color}-300`,
      `${color}-350`,
      `${color}-400`,
      `${color}-500`,
      `${color}-600`,
      `${color}-700`,
      `${color}-800`,
      `${color}-900`,
      ...(color === 'grey' ? ['grey-00', 'grey-650', 'grey-950', 'grey-1000'] : []),
    ]));

function normalizeFeishuPanelBorderColor(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (FEISHU_COLOR_ENUM_VALUES.has(normalized)) return normalized;
  if (/^rgba\(\s*(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\s*,\s*(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\s*,\s*(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\s*,\s*(?:0|1|0?\.\d+)\s*\)$/.test(normalized)) {
    return normalized;
  }
  return null;
}

function normalizeCardLine(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeCardMultiline(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function compactCardText(value: string | null | undefined, maxLength: number): string {
  const normalized = normalizeCardLine(value);
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 1) return '…';
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

interface MirrorGoalBlock {
  label: string;
  objective: string;
}

interface SplitMirrorGoalText {
  goal: MirrorGoalBlock | null;
  content: string;
}

function splitLeadingMirrorGoalText(text: string): SplitMirrorGoalText {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return { goal: null, content: '' };

  const markdownMatch = /^>\s*(?:⚙️\s*)?\*\*(Goal [^*]+)\*\*:\s*([^\n]*)(?:\n{2,}([\s\S]*))?$/.exec(normalized);
  if (markdownMatch) {
    return {
      goal: {
        label: markdownMatch[1].trim(),
        objective: markdownMatch[2].trim(),
      },
      content: (markdownMatch[3] || '').trim(),
    };
  }

  const plainMatch = /^(Goal [^:]+):\s*([^\n]*)(?:\n{2,}([\s\S]*))?$/.exec(normalized);
  if (plainMatch) {
    return {
      goal: {
        label: plainMatch[1].trim(),
        objective: plainMatch[2].trim(),
      },
      content: (plainMatch[3] || '').trim(),
    };
  }

  return { goal: null, content: normalized };
}

function buildMirrorGoalElement(goal: MirrorGoalBlock): Record<string, unknown> {
  const title = goal.objective.length > MIRROR_GOAL_COLLAPSE_THRESHOLD
    ? `${goal.label}：${compactCardText(goal.objective, 80)}`
    : `${goal.label}：${goal.objective}`;
  const content = goal.objective || '_无目标内容_';
  if (goal.objective.length <= MIRROR_GOAL_COLLAPSE_THRESHOLD) {
    return {
      tag: 'markdown',
      content: `> ⚙️ **${goal.label}**: ${content}`,
      text_align: 'left',
      text_size: 'notation',
    };
  }

  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: `⚙️ **${title}**` },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'notation',
    }],
  };
}

export function buildStreamingTextLayoutSignature(text: string): string {
  const { goal } = splitLeadingMirrorGoalText(text);
  if (!goal) return 'goal:none';
  const mode = goal.objective.length > MIRROR_GOAL_COLLAPSE_THRESHOLD ? 'collapsed' : 'inline';
  return `goal:${mode}:${goal.label}:${goal.objective}`;
}

export function buildStreamingTextElements(text: string, elementId = 'streaming_content'): Array<Record<string, unknown>> {
  const split = splitLeadingMirrorGoalText(text);
  const content = preprocessFeishuMarkdown(split.content || (split.goal ? '' : text || '💭 Thinking...'));
  const elements: Array<Record<string, unknown>> = [];
  if (split.goal) {
    elements.push(buildMirrorGoalElement(split.goal));
  }
  elements.push({
    tag: 'markdown',
    content: content || '💭 Thinking...',
    text_align: 'left',
    text_size: 'normal',
    element_id: elementId,
  });
  return elements;
}

function compactCardMultilineText(value: string | null | undefined, maxLength: number): string {
  const normalized = normalizeCardMultiline(value);
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 1) return '…';
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildRichCardSectionMarkdown(section: OutboundRichCardSection): string {
  const blocks: string[] = [];
  const title = compactCardText(section.title, RICH_CARD_TITLE_LIMIT);
  if (title) blocks.push(`#### ${title}`);
  const text = compactCardMultilineText(section.text, RICH_CARD_TEXT_LIMIT);
  if (text) blocks.push(text);
  if (section.markdown?.trim()) blocks.push(section.markdown.trim());

  const tableRows = (section.fields || [])
    .map(([label, value]) => [normalizeCardLine(label), compactCardMultilineText(value, RICH_CARD_FIELD_LIMIT)] as const)
    .filter(([, value]) => value);
  if (tableRows.length > 0) {
    blocks.push(tableRows.map(([label, value]) => `**${label}**\n${value}`).join('\n\n'));
  }

  if (section.code?.text.trim()) {
    blocks.push(buildFencedCodeBlock(section.code.text.trim(), section.code.language || 'text'));
  }
  return blocks.join('\n').trim();
}

function buildCardButtonColumn(button: FeishuCardActionButton, chatId?: string): Record<string, unknown> | null {
  if (!button.text || !button.callbackData) return null;
  return {
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: button.text },
      type: button.type || 'default',
      size: 'medium',
      disabled: Boolean(button.disabled),
      value: { callback_data: button.callbackData, ...(chatId ? { chatId } : {}) },
      behaviors: [{
        type: 'callback',
        value: { callback_data: button.callbackData, ...(chatId ? { chatId } : {}) },
      }],
    }],
  };
}

function normalizeSelectElementId(id: string | undefined, index: number): string {
  const normalized = String(id || `command_select_${index + 1}`)
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^[^A-Za-z]+/, '');
  const fallback = `command_select_${index + 1}`;
  const valid = normalized || fallback;
  if (valid.length <= 20) return valid;
  const suffix = `_${index + 1}`;
  return `${valid.slice(0, 20 - suffix.length)}${suffix}`;
}

function normalizeFormFieldName(name: string | undefined, fallback: string): string {
  const normalized = String(name || fallback)
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^[^A-Za-z]+/, '');
  return normalized || fallback;
}

function buildRichCardSelectElement(
  select: OutboundCardActionSelect,
  index: number,
  chatId?: string,
): Record<string, unknown> | null {
  const seenValues = new Set<string>();
  const options = (select.options || [])
    .map((option) => ({
      text: compactCardText(option.text, RICH_CARD_SELECT_OPTION_LIMIT),
      value: String(option.callbackData || '').trim(),
    }))
    .filter((option) => {
      if (!option.text || !option.value || seenValues.has(option.value)) return false;
      seenValues.add(option.value);
      return true;
    })
    .map((option) => {
      return {
        text: { tag: 'plain_text', content: option.text },
        value: option.value,
      };
    });
  const selectedValue = String(select.selectedCallbackData || '').trim();
  const hasSelectedValue = selectedValue && options.some((option) => option.value === selectedValue);

  if (options.length === 0) return null;

  return {
    tag: 'select_static',
    element_id: normalizeSelectElementId(select.id, index),
    placeholder: {
      tag: 'plain_text',
      content: compactCardText(select.placeholder || '请选择', RICH_CARD_SELECT_OPTION_LIMIT),
    },
    type: 'default',
    width: 'fill',
    disabled: false,
    ...(hasSelectedValue ? { initial_option: selectedValue } : {}),
    behaviors: [{
      type: 'callback',
      value: { select_id: normalizeSelectElementId(select.id, index), ...(chatId ? { chatId } : {}) },
    }],
    options,
  };
}

function buildRichCardSelectElements(
  selects: OutboundCardActionSelect[] = [],
  chatId?: string,
): Array<Record<string, unknown>> {
  return selects
    .map((select, index) => buildRichCardSelectElement(select, index, chatId))
    .filter((element): element is Record<string, unknown> => Boolean(element));
}

function normalizeRichCardFormOptions(rawOptions: OutboundCardActionSelectOption[] = []): Array<Record<string, unknown>> {
  return rawOptions
    .map((option) => ({
      text: compactCardText(option.text, RICH_CARD_SELECT_OPTION_LIMIT),
      value: String(option.callbackData || option.text || '').trim(),
    }))
    .filter((option) => option.text && option.value)
    .slice(0, 8)
    .map((option) => ({
      text: { tag: 'plain_text', content: option.text },
      value: option.value,
    }));
}

function buildRichCardFormLabeledField(label: string | undefined, element: Record<string, unknown>): Record<string, unknown>[] {
  const normalizedLabel = compactCardText(label || '', 80);
  if (!normalizedLabel) return [element];
  return [{
    tag: 'markdown',
    content: `**${normalizedLabel}**`,
    text_size: 'notation',
  }, element];
}

function buildRichCardFormControlSelectColumn(
  select: OutboundCardActionSelect,
  index: number,
  chatId?: string,
): Record<string, unknown> | null {
  const selectElement = buildRichCardSelectElement(select, index, chatId);
  if (!selectElement) return null;
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [selectElement],
  };
}

function buildRichCardFormControlButtonColumn(
  button: FeishuCardActionButton,
  chatId?: string,
): Record<string, unknown> | null {
  if (!button.text || !button.callbackData) return null;
  const behaviorValue = { callback_data: button.callbackData, ...(chatId ? { chatId } : {}) };
  return {
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      name: button.submit ? 'submit_btn' : undefined,
      text: { tag: 'plain_text', content: compactCardText(button.text, 40) },
      type: button.type || 'default',
      size: 'medium',
      disabled: Boolean(button.disabled),
      ...(button.submit ? { form_action_type: 'submit' } : {}),
      value: behaviorValue,
      behaviors: [{
        type: 'callback',
        value: behaviorValue,
      }],
    }],
  };
}

function buildRichCardFormControlBarElements(
  form: OutboundRichCard['form'],
  chatId?: string,
): Array<Record<string, unknown>> {
  const controlBar = form?.controlBar;
  if (!controlBar) return [];
  const selectColumns = (controlBar.selects || [])
    .map((select, index) => buildRichCardFormControlSelectColumn(select, index, chatId))
    .filter((column): column is Record<string, unknown> => Boolean(column));
  const columns = selectColumns;
  if (columns.length === 0) return [];
  const elements: Array<Record<string, unknown>> = [{
    tag: 'column_set',
    flex_mode: 'stretch',
    horizontal_align: 'left',
    columns,
  }];
  if (controlBar.dividerAfter) elements.push({ tag: 'hr' });
  return elements;
}

function buildRichCardFormElements(
  form: OutboundRichCard['form'] | undefined,
  chatId?: string,
): Array<Record<string, unknown>> {
  if (!form || !form.submitCallbackData) return [];
  const options = normalizeRichCardFormOptions(form.options);
  const fieldGroups: Array<Record<string, unknown>[]> = [];
  if (options.length > 0) {
    fieldGroups.push([{
      tag: 'select_static',
      name: normalizeFormFieldName(form.optionFormName, form.optionElementId || 'clk_choice'),
      placeholder: { tag: 'plain_text', content: '请选择' },
      type: 'default',
      width: 'fill',
      options,
    }]);
  }
  for (const select of form.selects || []) {
    const selectOptions = normalizeRichCardFormOptions(select.options);
    if (selectOptions.length === 0) continue;
    const selectedValue = String(select.selectedCallbackData || '').trim();
    fieldGroups.push(buildRichCardFormLabeledField(select.label, {
      tag: 'select_static',
      name: normalizeFormFieldName(select.formName, select.elementId),
      placeholder: { tag: 'plain_text', content: compactCardText(select.placeholder || '保持当前值', 120) },
      type: 'default',
      width: 'fill',
      ...(selectedValue && selectOptions.some((option) => option.value === selectedValue) ? { initial_option: selectedValue } : {}),
      options: selectOptions,
    }));
  }
  if (form.inputLabel) {
    fieldGroups.push(buildRichCardFormLabeledField(form.inputLabel, {
      tag: 'input',
      name: normalizeFormFieldName(form.inputFormName, form.inputElementId || 'clk_input'),
      placeholder: { tag: 'plain_text', content: compactCardText(form.inputPlaceholder || '可留空', 120) },
      default_value: compactCardText(form.inputDefaultValue || '', 500),
      input_type: 'text',
    }));
  }
  for (const extraInput of form.extraInputs || []) {
    fieldGroups.push(buildRichCardFormLabeledField(extraInput.label, {
      tag: 'input',
      name: normalizeFormFieldName(extraInput.formName, extraInput.elementId || 'clk_extra_input'),
      placeholder: { tag: 'plain_text', content: compactCardText(extraInput.placeholder || '可留空', 120) },
      default_value: compactCardText(extraInput.defaultValue || '', 500),
      input_type: 'text',
    }));
  }
  const formElements: Array<Record<string, unknown>> = fieldGroups.flat();
  if (!form.controlBar?.actions?.some((button) => button.submit)) {
    const submitValue = {
      callback_data: form.submitCallbackData,
      ...(chatId ? { chatId } : {}),
    };
    const actionButtons = (form.controlBar?.actions || [])
      .filter((button) => !button.submit)
      .map((button) => buildRichCardFormControlButtonColumn(button, chatId))
      .filter((column): column is Record<string, unknown> => Boolean(column))
      .flatMap((column) => Array.isArray(column.elements) ? column.elements : []);
    if (form.actionDividerBefore && formElements.length > 0) {
      formElements.push({ tag: 'hr' });
    }
    formElements.push({
      tag: 'button',
      name: 'submit_btn',
      text: { tag: 'plain_text', content: compactCardText(form.submitText || '提交', 40) },
      type: 'primary',
      form_action_type: 'submit',
      value: submitValue,
      behaviors: [{
        type: 'callback',
        value: submitValue,
      }],
    });
    formElements.push(...actionButtons);
  }

  const elements: Array<Record<string, unknown>> = [{
    tag: 'form',
    name: 'clk_form',
    elements: [
      ...buildRichCardFormControlBarElements(form, chatId),
      ...formElements,
    ],
  }];

  return elements;
}

function buildRichCardFieldColumn(label: string, value: string): Record<string, unknown> {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [{
      tag: 'markdown',
      content: `**${label}**\n${value}`,
      text_align: 'left',
      text_size: 'notation',
    }],
  };
}

function buildRichCardSectionElements(
  section: OutboundRichCardSection,
  chatId?: string,
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [];
  const title = compactCardText(section.title, RICH_CARD_TITLE_LIMIT);
  const text = compactCardMultilineText(section.text, RICH_CARD_TEXT_LIMIT);
  const markdown = section.markdown?.trim();
  const fields = (section.fields || [])
    .map(([label, value]) => [normalizeCardLine(label), compactCardMultilineText(value, RICH_CARD_FIELD_LIMIT)] as const)
    .filter(([label, value]) => label && value);
  const inlineFields = fields.slice(0, RICH_CARD_INLINE_FIELD_LIMIT);
  const foldedFields = fields.slice(inlineFields.length);
  const [firstActionRow = [], ...restActionRows] = section.actions || [];

  const columns: Array<Record<string, unknown>> = [];
  const mainBlocks: string[] = [];
  if (title) mainBlocks.push(`#### ${title}`);
  if (text) mainBlocks.push(text);
  if (markdown) mainBlocks.push(markdown);
  if (foldedFields.length > 0) {
    mainBlocks.push(`已压缩 ${foldedFields.length} 项：${foldedFields.map(([label]) => label).join('、')}`);
  }
  const mainContent = mainBlocks.join('\n').trim();
  if (mainContent) {
    columns.push({
      tag: 'column',
      width: 'weighted',
      weight: 3,
      elements: [{
        tag: 'markdown',
        content: preprocessFeishuMarkdown(mainContent),
        text_align: 'left',
        text_size: 'normal',
      }],
    });
  }
  inlineFields.forEach(([label, value]) => {
    columns.push(buildRichCardFieldColumn(label, value));
  });
  firstActionRow
    .map((button) => buildCardButtonColumn(button, chatId))
    .filter((column): column is Record<string, unknown> => Boolean(column))
    .forEach((column) => columns.push(column));

  if (columns.length > 0) {
    elements.push({
      tag: 'column_set',
      flex_mode: 'stretch',
      horizontal_align: 'left',
      columns,
    });
  }

  if (section.code?.text.trim()) {
    elements.push({
      tag: 'markdown',
      content: preprocessFeishuMarkdown(buildFencedCodeBlock(section.code.text.trim(), section.code.language || 'text')),
      text_align: 'left',
      text_size: 'normal',
    });
  }

  if (columns.length === 0) {
    const fallback = buildRichCardSectionMarkdown(section);
    if (fallback) {
      elements.push({
        tag: 'markdown',
        content: preprocessFeishuMarkdown(fallback),
        text_align: 'left',
        text_size: 'normal',
      });
    }
  }

  if (section.image?.imageKey.trim()) {
    elements.push({
      tag: 'img',
      img_key: section.image.imageKey.trim(),
      alt: {
        tag: 'plain_text',
        content: compactCardText(section.image.alt || '图片', 80),
      },
      mode: section.image.mode || 'fit_horizontal',
      preview: section.image.preview !== false,
    });
  }

  const restActions = buildCardActionElements(restActionRows, chatId);
  if (restActions.length > 0) {
    elements.push(...restActions);
  }
  return elements;
}

function clampTablePageSize(value: number | undefined): number {
  if (!Number.isFinite(value || 0)) return 10;
  return Math.min(10, Math.max(1, Math.trunc(value || 10)));
}

function normalizeTableColumnWidth(value: string | undefined): string {
  const width = String(value || 'auto').trim();
  if (!width || width === 'auto') return 'auto';

  const pixelMatch = /^(\d+)px$/.exec(width);
  if (pixelMatch) {
    const pixels = Number(pixelMatch[1]);
    return `${Math.min(600, Math.max(80, pixels))}px`;
  }

  const percentMatch = /^(\d+)%$/.exec(width);
  if (percentMatch) {
    const percent = Number(percentMatch[1]);
    return `${Math.min(100, Math.max(1, percent))}%`;
  }

  return 'auto';
}

function normalizeTableRowHeight(value: OutboundRichCardTable['rowHeight']): string {
  const rowHeight = String(value || 'low').trim();
  if (rowHeight === 'low' || rowHeight === 'middle' || rowHeight === 'high' || rowHeight === 'auto') {
    return rowHeight;
  }
  if (rowHeight === 'medium') return 'middle';

  const pixelMatch = /^(\d+)px$/.exec(rowHeight);
  if (pixelMatch) {
    const pixels = Number(pixelMatch[1]);
    return `${Math.min(124, Math.max(32, pixels))}px`;
  }

  return 'low';
}

function buildRichCardTableElement(table: OutboundRichCardTable): Record<string, unknown> | null {
  const columns = table.columns
    .filter((column) => column.name && column.displayName)
    .map((column) => ({
      name: column.name,
      display_name: column.displayName,
      width: normalizeTableColumnWidth(column.width),
      data_type: column.dataType || 'text',
      vertical_align: column.verticalAlign || 'top',
      horizontal_align: column.horizontalAlign || 'left',
    }));
  if (columns.length === 0 || table.rows.length === 0) return null;

  const allowedColumnNames = new Set(columns.map((column) => String(column.name)));
  const rows = table.rows.map((row) => {
    const normalized: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!allowedColumnNames.has(key) || value === null || value === undefined) continue;
      normalized[key] = typeof value === 'number' ? value : compactCardText(value, 500);
    }
    return normalized;
  });

  return {
    tag: 'table',
    page_size: clampTablePageSize(table.pageSize),
    row_height: normalizeTableRowHeight(table.rowHeight),
    freeze_first_column: Boolean(table.freezeFirstColumn),
    columns,
    rows,
  };
}

function buildRichCardPanelElement(
  panel: NonNullable<OutboundRichCard['panels']>[number],
  index: number,
  chatId?: string,
): Record<string, unknown> | null {
  const title = compactCardText(panel.title, RICH_CARD_TITLE_LIMIT);
  if (!title) return null;

  const elements: Array<Record<string, unknown>> = [];
  const subtitle = compactCardMultilineText(panel.subtitle, RICH_CARD_TEXT_LIMIT);
  if (subtitle) {
    elements.push({
      tag: 'markdown',
      content: preprocessFeishuMarkdown(subtitle),
      text_align: 'left',
      text_size: 'notation',
    });
  }

  if (panel.table) {
    const tableElement = buildRichCardTableElement(panel.table);
    if (tableElement) {
      if (elements.length > 0) elements.push({ tag: 'hr' });
      elements.push(tableElement);
    }
  }

  for (const section of panel.sections || []) {
    const sectionElements = buildRichCardSectionElements(section, chatId);
    if (sectionElements.length === 0) continue;
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push(...sectionElements);
  }

  const selectElements = buildRichCardSelectElements(panel.selects || [], chatId);
  if (selectElements.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push(...selectElements);
  }

  const actionElements = buildCardActionElements(panel.actions || [], chatId);
  if (actionElements.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push(...actionElements);
  }

  const footer = (panel.footer || []).map((line) => line.trim()).filter(Boolean);
  if (footer.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: preprocessFeishuMarkdown(footer.join('\n')),
      text_size: 'notation',
    });
  }

  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: '无内容', text_size: 'notation' });
  }

  const borderColor = normalizeFeishuPanelBorderColor(panel.template);
  return {
    tag: 'collapsible_panel',
    expanded: Boolean(panel.expanded),
    header: {
      title: { tag: 'markdown', content: title },
    },
    ...(borderColor ? { border: { color: borderColor, corner_radius: '5px' } } : {}),
    elements,
    element_id: `rich_panel_${index + 1}`,
  };
}

function buildRichCardTableBlockElements(
  block: NonNullable<OutboundRichCard['tableBlocks']>[number],
  index: number,
  chatId?: string,
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [];
  const title = compactCardText(block.title, RICH_CARD_TITLE_LIMIT);
  const subtitle = compactCardMultilineText(block.subtitle, RICH_CARD_TEXT_LIMIT);
  const titleColor = compactCardText(block.titleColor, 32);
  const renderedTitle = title && titleColor ? `<font color='${titleColor}'>#### ${title}</font>` : title ? `#### ${title}` : '';
  const header = [renderedTitle, subtitle].filter(Boolean).join('\n').trim();
  if (header) {
    elements.push({
      tag: 'markdown',
      content: preprocessFeishuMarkdown(header),
      text_align: 'left',
      text_size: 'notation',
    });
  }

  const tableElement = buildRichCardTableElement(block.table);
  if (tableElement) elements.push(tableElement);

  const selectElements = buildRichCardSelectElements(block.selects || [], chatId);
  if (selectElements.length > 0) elements.push(...selectElements);

  const actionElements = buildCardActionElements(block.actions || [], chatId);
  if (actionElements.length > 0) elements.push(...actionElements);

  const footer = (block.footer || []).map((line) => line.trim()).filter(Boolean);
  if (footer.length > 0) {
    elements.push({
      tag: 'markdown',
      content: preprocessFeishuMarkdown(footer.join('\n')),
      text_size: 'notation',
    });
  }

  if (elements.length === 0) {
    console.warn('[feishu-markdown] Skipped empty rich card table block:', index);
  }
  return elements;
}

export function buildRichCardContent(card: OutboundRichCard, chatId?: string): string {
  const elements: Array<Record<string, unknown>> = [];

  if (card.subtitle?.trim()) {
    elements.push({
      tag: 'markdown',
      content: preprocessFeishuMarkdown(card.subtitle.trim()),
      text_size: 'notation',
    });
  }

  if (card.table) {
    const tableElement = buildRichCardTableElement(card.table);
    if (tableElement) {
      if (elements.length > 0) elements.push({ tag: 'hr' });
      elements.push(tableElement);
    }
  }

  const tableBlockElements = (card.tableBlocks || [])
    .map((block, index) => buildRichCardTableBlockElements(block, index, chatId))
    .filter((blockElements) => blockElements.length > 0);
  if (tableBlockElements.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    tableBlockElements.forEach((blockElements, index) => {
      if (index > 0) elements.push({ tag: 'hr' });
      elements.push(...blockElements);
    });
  }

  const panelElements = (card.panels || [])
    .map((panel, index) => buildRichCardPanelElement(panel, index, chatId))
    .filter((panel): panel is Record<string, unknown> => Boolean(panel));
  if (panelElements.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push(...panelElements);
  }

  const selectElements = buildRichCardSelectElements(card.selects || [], chatId);
  if (selectElements.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push(...selectElements);
  }

  const formElements = buildRichCardFormElements(card.form, chatId);
  if (formElements.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push(...formElements);
  }

  const maxSections = Math.max(0, card.maxSections ?? DEFAULT_RICH_CARD_MAX_SECTIONS);
  const visibleSections = card.sections.slice(0, maxSections);
  const hiddenSectionCount = card.sections.length - visibleSections.length;

  visibleSections.forEach((section) => {
    const sectionElements = buildRichCardSectionElements(section, chatId);
    if (sectionElements.length === 0) return;
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push(...sectionElements);
  });

  const cardActions = buildCardActionElements(card.actions || [], chatId);
  if (cardActions.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push(...cardActions);
  }

  const footer = [
    ...(hiddenSectionCount > 0
      ? [`已压缩显示前 ${visibleSections.length} 条，折叠 ${hiddenSectionCount} 条；发送纯文本命令可查看完整列表。`]
      : []),
    ...(card.footer || []),
  ].map((line) => line.trim()).filter(Boolean);
  if (footer.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: preprocessFeishuMarkdown(footer.join('\n')),
      text_size: 'notation',
    });
  }
  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: '无内容', text_size: 'normal' });
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: card.title },
      template: card.template || 'blue',
      ...((card.tags || []).filter(Boolean).length > 0
        ? {
            text_tag_list: (card.tags || []).filter(Boolean).slice(0, 3).map((tag, index) => ({
              tag: 'text_tag',
              element_id: `rich_title_tag_${index + 1}`,
              text: { tag: 'plain_text', content: compactCardText(tag, 24) },
              color: card.tagColor || 'green',
            })),
          }
        : {}),
    },
    body: { elements },
  });
}

/**
 * Build Feishu post message content (msg_type: 'post') with md tag.
 * Used for simple text without code blocks or tables.
 * Aligned with Openclaw's buildFeishuPostMessagePayload().
 */
export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text: preprocessFeishuMarkdown(text) }]],
    },
  });
}

/**
 * Convert simple HTML (from command responses) to markdown for Feishu.
 * Handles common tags: <b>, <i>, <code>, <br>, entities.
 */
export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function panelBorderStyle(color: string | null | undefined, cornerRadius: string): Record<string, unknown> {
  const normalized = normalizeFeishuPanelBorderColor(color);
  return normalized ? { border: { color: normalized, corner_radius: cornerRadius } } : {};
}

function toolPanelBorderColor(status: ToolCallInfo['status']): string | null {
  return DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.innerPanel.borderColorByStatus[status] ?? null;
}

function buildToolProgressPanelTitle(block: ToolProgressBlock): string {
  return block.presentation.title;
}

function buildToolProgressPanelDetailElements(block: ToolProgressBlock): Array<Record<string, unknown>> {
  const detail = block.detail.trim();
  if (detail) {
    return [{
      tag: 'markdown',
      content: preprocessFeishuMarkdown(detail),
      text_align: 'left',
      text_size: DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.innerPanel.detailTextSize,
    }];
  }
  return [{
    tag: 'markdown',
    content: block.tool.id === 'hidden' ? '请查看完整会话历史获取更早的工具调用。' : '没有额外详情。',
    text_align: 'left',
    text_size: DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.innerPanel.detailTextSize,
  }];
}

function buildToolProgressPanel(block: ToolProgressBlock, index: number, elementIdPrefix = 'stream_tool'): Record<string, unknown> {
  const elementId = `${elementIdPrefix}_${index + 1}`;
  const title = buildToolProgressPanelTitle(block);
  const elements = buildToolProgressPanelDetailElements(block);
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'markdown',
        content: title,
        text_size: DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.innerPanel.titleTextSize,
      },
    },
    ...panelBorderStyle(
      toolPanelBorderColor(block.tool.status),
      DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.innerPanel.borderCornerRadius,
    ),
    elements,
    element_id: elementId,
  };
}

function splitHistoryContentBlocks(content: string): string[] {
  const normalized = content.trim();
  return normalized ? normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean) : [];
}

export function buildToolProgressGroupPanel(
  tools: ToolCallInfo[],
  panelIndex: number,
  options: ToolProgressRenderOptions = {},
): Record<string, unknown> | null {
  if (tools.length === 0) return null;
  const blocks = buildToolProgressBlocks(tools, { ...options, maxItems: null });
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'markdown',
        content: `工具调用 · ${tools.length}`,
        text_size: DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.outerPanel.titleTextSize,
      },
    },
    ...panelBorderStyle(
      DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.outerPanel.borderColor,
      DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.outerPanel.borderCornerRadius,
    ),
    elements: blocks.map((block, index) => buildToolProgressPanel(block, index, `st_${panelIndex + 1}_t`)),
    element_id: `stream_tool_${panelIndex + 1}`,
  };
}

function initialStreamingHistoryItemsForRender(): StreamingHistoryItem[] {
  return [
    { type: 'markdown', role: 'thinking', content: '💭 Thinking...' },
  ];
}

function buildHistoryMarkdownElement(
  content: string,
  elementId?: string,
): Record<string, unknown> | null {
  const normalized = preprocessFeishuMarkdown(content).trim();
  if (!normalized) return null;
  return {
    tag: 'markdown',
    content: normalized,
    text_align: 'left',
    text_size: 'normal',
    ...(elementId ? { element_id: elementId } : {}),
  };
}

function formatHistoryMarkdownContent(item: Extract<StreamingHistoryItem, { type: 'markdown' }>): string {
  if (item.role !== 'user') return item.content;
  const trimmed = item.content.trim();
  if (!trimmed || /^\*\*用户\*\*/.test(trimmed)) return item.content;
  return `**用户**：${trimmed}`;
}

function userInputTitlePreview(content: string): string {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(normalized);
  return chars.length > FEISHU_LONG_USER_INPUT_TITLE_LIMIT
    ? `${chars.slice(0, FEISHU_LONG_USER_INPUT_TITLE_LIMIT).join('')}…`
    : normalized;
}

function buildHistoryItemElement(
  item: Extract<StreamingHistoryItem, { type: 'markdown' }>,
  elementId: string,
): Record<string, unknown> | null {
  const formatted = formatHistoryMarkdownContent(item);
  if (
    item.role !== 'user'
    || Array.from(item.content.trim()).length <= FEISHU_LONG_USER_INPUT_COLLAPSE_THRESHOLD
  ) {
    return buildHistoryMarkdownElement(formatted, elementId);
  }

  const fullContent = buildHistoryMarkdownElement(formatted);
  if (!fullContent) return null;
  const titleSource = /^\*\*用户\*\*/.test(item.content.trim())
    ? item.content.trim()
    : `**用户**：${item.content.trim()}`;
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'markdown',
        content: preprocessFeishuMarkdown(userInputTitlePreview(titleSource)),
        text_size: 'normal',
      },
    },
    elements: [fullContent],
    element_id: elementId,
  };
}

export function buildToolProgressElements(
  tools: ToolCallInfo[],
  options: ToolProgressRenderOptions = {},
): Array<Record<string, unknown>> {
  return buildToolProgressBlocks(tools, options).map((block, index) => buildToolProgressPanel(block, index));
}

export function buildStreamingHistoryElementsFromItems(
  text: string,
  items: StreamingHistoryItem[],
  elementId = 'streaming_content',
  options: ToolProgressRenderOptions = {},
): Array<Record<string, unknown>> {
  const split = splitLeadingMirrorGoalText(text);
  const elements: Array<Record<string, unknown>> = [];
  if (split.goal) {
    elements.push(buildMirrorGoalElement(split.goal));
  }

  const sourceItems = items.length > 0 ? items : initialStreamingHistoryItemsForRender();
  let markdownCount = 0;
  let toolPanelCount = 0;
  const historyElements: Array<Record<string, unknown>> = [];
  for (const item of sourceItems) {
    if (item.type === 'tool_panel') {
      const rendered = buildToolProgressGroupPanel(item.tools, toolPanelCount, options);
      if (rendered) historyElements.push(rendered);
      toolPanelCount += 1;
      continue;
    }
    const resolvedElementId = item.elementId
      || (markdownCount === 0 ? elementId : `stream_txt_${markdownCount + 1}`);
    const markdownElement = buildHistoryItemElement(item, resolvedElementId);
    markdownCount += 1;
    if (markdownElement) historyElements.push(markdownElement);
  }

  if (historyElements.length === 0) {
    historyElements.push(...buildStreamingHistoryElementsFromItems('', initialStreamingHistoryItemsForRender(), elementId, options));
  }

  elements.push({
    tag: 'collapsible_panel',
    expanded: true,
    header: {
      title: { tag: 'markdown', content: '历史记录' },
    },
    border: { color: 'grey', corner_radius: '5px' },
    elements: historyElements,
    element_id: 'stream_history',
  });
  return elements;
}

export function buildStreamingHistoryElements(
  text: string,
  tools: ToolCallInfo[] = [],
  elementId = 'streaming_content',
  options: ToolProgressRenderOptions = {},
): Array<Record<string, unknown>> {
  if (!text.trim() && tools.length === 0) {
    return buildStreamingHistoryElementsFromItems(text, initialStreamingHistoryItemsForRender(), elementId, options);
  }

  const split = splitLeadingMirrorGoalText(text);
  const content = split.content || (split.goal ? '' : text || '💭 Thinking...');
  const elements: Array<Record<string, unknown>> = [];
  if (split.goal) {
    elements.push(buildMirrorGoalElement(split.goal));
  }

  const historyElements: Array<Record<string, unknown>> = [];
  const contentBlocks = splitHistoryContentBlocks(content);
  if (contentBlocks.length === 0) contentBlocks.push('💭 Thinking...');
  for (const block of contentBlocks) {
    const blockElement = buildHistoryMarkdownElement(block, historyElements.length === 0 ? elementId : undefined);
    if (blockElement) historyElements.push(blockElement);
  }
  const toolGroup = buildToolProgressGroupPanel(tools, 0, options);
  if (toolGroup) historyElements.push(toolGroup);

  if (historyElements.length === 0) {
    const fallback = buildHistoryMarkdownElement('💭 Thinking...', elementId);
    if (fallback) historyElements.push(fallback);
  }

  elements.push({
    tag: 'collapsible_panel',
    expanded: true,
    header: {
      title: { tag: 'markdown', content: '历史记录' },
    },
    border: { color: 'grey', corner_radius: '5px' },
    elements: historyElements,
    element_id: 'stream_history',
  });
  return elements;
}

function withoutDuplicateTerminalContext(
  items: StreamingHistoryItem[],
  finalContextLine: string,
): StreamingHistoryItem[] {
  if (!finalContextLine) return items;
  let removed = false;
  return items.map((item, index) => {
    if (removed || item.type !== 'markdown' || item.role !== 'assistant') return item;
    const laterAssistantContainsContext = items.slice(index + 1).some((later) => (
      later.type === 'markdown'
      && later.role === 'assistant'
      && later.content.split(/\r?\n/).some((line) => line.trim() === finalContextLine)
    ));
    if (laterAssistantContainsContext) return item;
    const lines = item.content.split(/\r?\n/);
    const contextIndex = lines.findLastIndex((line) => line.trim() === finalContextLine);
    if (contextIndex < 0) return item;
    removed = true;
    lines.splice(contextIndex, 1);
    return { ...item, content: lines.join('\n').trim() };
  });
}

function getTaskProgressPresentation(
  task: TaskProgressInfo,
  options: ToolProgressRenderOptions,
): { icon: string; label: string } {
  if (!options.terminalStatus) {
    return task.status === 'completed'
      ? { icon: '✅', label: '已完成' }
      : task.status === 'in_progress'
        ? { icon: '🔄', label: '执行中' }
        : { icon: '⏳', label: '等待中' };
  }

  if (task.status === 'completed') {
    return { icon: '✅', label: '已完成' };
  }

  if (options.terminalStatus === 'completed') {
    return { icon: '✅', label: '已结束' };
  }
  if (options.terminalStatus === 'interrupted') {
    return task.status === 'pending'
      ? { icon: '⚠️', label: '未执行' }
      : { icon: '⚠️', label: '已停止' };
  }
  return task.status === 'pending'
    ? { icon: '❌', label: '未执行' }
    : { icon: '❌', label: '已中断' };
}

export function buildTaskProgressMarkdown(
  tasks: TaskProgressInfo[],
  options: ToolProgressRenderOptions = {},
): string {
  if (tasks.length === 0) return '';
  return tasks
    .map((task) => {
      const { icon, label } = getTaskProgressPresentation(task, options);
      return `${icon} ${task.text}（${label}）`;
    })
    .join('\n');
}

/**
 * Format elapsed time for card footer.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

/**
 * Build the body text for the primary streaming content region.
 */
export function buildStreamingTextContent(text: string): string {
  const split = splitLeadingMirrorGoalText(text);
  return preprocessFeishuMarkdown(split.content || (split.goal ? '' : text || '💭 Thinking...'));
}

/**
 * Build the tool-only markdown content for the dedicated streaming tools region.
 */
export function buildStreamingToolsContent(tools: ToolCallInfo[]): string {
  return buildToolProgressMarkdown(tools);
}

export function buildStreamingToolsElements(tools: ToolCallInfo[]): Array<Record<string, unknown>> {
  return buildToolProgressElements(tools);
}

export function buildStreamingTaskContent(tasks: TaskProgressInfo[]): string {
  return buildTaskProgressMarkdown(tasks);
}

export function buildCardActionElements(
  actionRows: FeishuCardActionButton[][] = [],
  chatId?: string,
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [];
  for (const row of actionRows) {
    const columns = row
      .filter((button) => button.text && button.callbackData)
      .map((button) => buildCardButtonColumn(button, chatId))
      .filter((column): column is Record<string, unknown> => Boolean(column));
    if (columns.length === 0) continue;
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_align: 'left',
      columns,
    });
  }
  return elements;
}

/**
 * Build the final card JSON (schema 2.0) with text, tool progress, and footer.
 */
export function buildFinalCardJson(
  text: string,
  tasks: TaskProgressInfo[],
  tools: ToolCallInfo[],
  footer: {
    status: string;
    currentTime?: string;
    elapsed: string;
    lastResponse?: string;
    context?: string;
    lastIo?: string;
  } | null,
  terminalStatus?: FinalCardTerminalStatus,
  actionRows: FeishuCardActionButton[][] = [],
  chatId?: string,
  metadata: StructuredStreamingUiMetadata = {},
  historyItems?: StreamingHistoryItem[],
): string {
  const elements: Array<Record<string, unknown>> = [];
  const finalContextLine = historyItems
    ? text.trim().split(/\n+/).reverse().find((line) => /^Context:\s+/.test(line.trim()))?.trim() || ''
    : '';
  const renderedHistoryItems = historyItems
    ? withoutDuplicateTerminalContext(historyItems, finalContextLine)
    : undefined;

  elements.push(...buildMetadataTagElements(metadata));

  // Main text content
  const renderOptions = { terminalStatus };
  const contentElements = (text.trim() || tools.length > 0 || Boolean(renderedHistoryItems?.length))
    ? renderedHistoryItems
      ? buildStreamingHistoryElementsFromItems(text, renderedHistoryItems, 'final_content', renderOptions)
      : buildStreamingHistoryElements(text, tools, 'final_content', renderOptions)
    : [];
  const taskMd = buildTaskProgressMarkdown(tasks, renderOptions);

  if (contentElements.length > 0) {
    elements.push(...contentElements);
  }

  // A history-driven provider may also append its terminal Context line to
  // the response text. Keep it as a standalone fallback only when the shared
  // footer has no normalized context value; otherwise every runtime uses the
  // same single-line footer.
  if (finalContextLine && !footer?.context) {
    if (elements.length > 0) {
      elements.push({ tag: 'hr' });
    }
    elements.push({
      tag: 'markdown',
      content: preprocessFeishuMarkdown(finalContextLine),
      text_align: 'left',
      text_size: 'notation',
    });
  }

  if (taskMd) {
    if (elements.length > 0) {
      elements.push({ tag: 'hr' });
    }
    elements.push({
      tag: 'markdown',
      content: preprocessFeishuMarkdown(taskMd),
      text_align: 'left',
      text_size: 'normal',
    });
  }

  // Footer
  if (footer) {
    const parts: string[] = [];
    if (footer.status) parts.push(footer.status);
    if (footer.currentTime) parts.push(footer.currentTime);
    if (footer.elapsed) parts.push(footer.elapsed);
    if (footer.lastResponse) parts.push(footer.lastResponse);
    if (footer.context) parts.push(footer.context);
    if (footer.lastIo) parts.push(footer.lastIo);
    if (parts.length > 0) {
      if (elements.length > 0) {
        elements.push({ tag: 'hr' });
      }
      elements.push({
        tag: 'markdown',
        content: preprocessFeishuMarkdown(parts.join(' · ')),
        text_size: 'notation',
      });
    }
  }

  const actionElements = buildCardActionElements(actionRows, chatId);
  if (actionElements.length > 0) {
    if (elements.length > 0) {
      elements.push({ tag: 'hr' });
    }
    elements.push(...actionElements);
  }

  const header = buildCardTitleHeader(metadata);
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    ...(header ? { header } : {}),
    body: { elements },
  });
}

/**
 * Build a permission card with real action buttons (column_set layout).
 * Structure aligned with CodePilot's working Feishu outbound implementation.
 * Returns the card JSON string for msg_type: 'interactive'.
 */
export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
): string {
  const buttons = [
    { label: 'Allow', type: 'primary', action: 'allow' },
    { label: 'Allow Session', type: 'default', action: 'allow_session' },
    { label: 'Deny', type: 'danger', action: 'deny' },
  ];

  const buttonColumns = buttons.map((btn) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.type,
      size: 'medium',
      value: { callback_data: `perm:${btn.action}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) },
      behaviors: [{
        type: 'callback',
        value: { callback_data: `perm:${btn.action}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) },
      }],
    }],
  }));

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Permission Required' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: preprocessFeishuMarkdown(text), text_size: 'normal' },
        { tag: 'markdown', content: '⏱ This request will expire in 5 minutes', text_size: 'notation' },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: buttonColumns,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: 'Or reply: `1` Allow · `2` Allow Session · `3` Deny',
          text_size: 'notation',
        },
      ],
    },
  });
}
