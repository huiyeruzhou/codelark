<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';

const props = defineProps<{
  code64: string;
}>();

const { isDark } = useData();
const root = ref<HTMLElement | null>(null);
const error = ref<string | null>(null);

const source = computed(() => {
  if (typeof window === 'undefined') return '';
  try {
    return decodeURIComponent(escape(window.atob(props.code64)));
  } catch {
    return '';
  }
});

async function renderDiagram(): Promise<void> {
  if (!root.value || !source.value) return;
  try {
    error.value = null;
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: isDark.value ? 'dark' : 'default',
    });
    const id = `mermaid-${Math.random().toString(36).slice(2)}`;
    const { svg } = await mermaid.render(id, source.value);
    root.value.innerHTML = svg;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    root.value.innerHTML = '';
  }
}

onMounted(() => {
  void renderDiagram();
});

watch(isDark, async () => {
  await nextTick();
  await renderDiagram();
});
</script>

<template>
  <figure class="mermaid-diagram">
    <div ref="root" class="mermaid-diagram__canvas" />
    <pre v-if="error" class="mermaid-diagram__error"><code>{{ source }}</code></pre>
    <figcaption v-if="error" class="mermaid-diagram__caption">
      Mermaid 渲染失败：{{ error }}
    </figcaption>
  </figure>
</template>
