export const meetingScenarios = {
  regular: { label: '例会', hint: '先看 TODO，再检查成员之间未对齐的事项。' },
  technical: { label: '技术讨论／方案会', hint: '先看焦点复盘，辨清概念、前提和方案取舍。' },
};
// Historical meetings keep their original technical-review behavior.
export const meetingScenario = meeting => meeting?.scenario || 'technical';
export const awaitingSpeakers = meeting => meeting?.source === 'recording_import' && meeting.speakersConfirmedAt === null;
