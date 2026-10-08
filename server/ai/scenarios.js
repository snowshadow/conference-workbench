import { meetingScenario } from '../../shared/meeting-scenarios.js';

export const REGULAR_SCENE = `本场是例会，目的是查缺补漏。优先提取 TODO、责任人、时间、依赖和阻塞；负责人和时间只有原文明示才填写，不能只因某人汇报就把任务归给他；明确的第一人称承诺（如“我明天负责联调”）可归给该条原文已确认的说话人，owner 使用 [[person:participantId]]，他人明确指派的任务可按原文姓名记录 owner，但不当成本人承诺；缺失时留空供核对。
澄清只关注会影响协作的未对齐：不同成员对同一交付、范围、责任、依赖、时间或完成标准的说法是否不一致。引用各自实际表达，说明差别及影响；单人转述不能证明另一人的立场，身份未确认时不能断定是两人的分歧。后来已经对齐的事项保留最终结果，不再列作潜在分歧。一般进度汇报、普通未决细节和独立的待办不需要升格成焦点；缺少负责人或日期可以是 TODO 的待补信息，不因此捏造分歧。没有有依据的未对齐就返回空列表。
不生成以回顾讨论过程、概念教学或已解决误会为目的的复盘焦点。保留人工记录，不以 AI 判断冒充会议共识。`;
export const TECHNICAL_SCENE = `本场是技术讨论／方案会，焦点是概念、隐含前提、判断标准和方案取舍，帮助发现未言明的分歧。辨清不同说法谈的是同一对象还是不同层次；明确已达成的结论、适用条件和待验证前提。不把不同表述自动当成分歧，也不把单方解释当成共同确认。`;
export const sceneInstructions = meeting => meetingScenario(meeting) === 'regular' ? REGULAR_SCENE : TECHNICAL_SCENE;
export const REGULAR_TOPICS = `按例会场景整理会议，topics 用于保存 TODO、明确决定和必要进度，不重建讨论时间线。读取全部提供的原文及后文修正，合并同一事项。
${REGULAR_SCENE}
coverage.complete=false 时只做分段提取，followups 可保留供全场核对的未对齐候选，不能把本段没有答案当成会末未解决。
coverage.complete=true 时同一次输出最终 topics 和 followups：TODO 存入 type=action 的 entries，潜在分歧存入 followups，retrospective=true，clarification.explanation 写清需核对的差别。已经对齐或没有证据支持的候选不再保留；已有人工记录保持原样，已有焦点沿用 ID。resolution 仅记录原话支持的实际进展。无需再单独生成一轮复盘。
若给出 outputBudgetChars，简洁保留任务、责任、依赖、不同主张和后来的修正及引用，供下一轮综合，不丢失未定事项。`;
