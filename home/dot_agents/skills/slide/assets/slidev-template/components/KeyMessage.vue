<script setup lang="ts">
// spacer: Key Message が無いページで同じ高さを確保し、図の位置をページ間で揃える
defineProps<{ spacer?: boolean }>()
</script>

<template>
  <!-- 中身が空でも 1 行分の高さを持たせ、spacer と文字入りの高さを揃える -->
  <p class="km" :class="{ spacer }"><slot>&nbsp;</slot></p>
</template>
