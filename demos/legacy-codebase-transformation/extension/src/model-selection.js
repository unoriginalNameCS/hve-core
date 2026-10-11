'use strict';

async function selectLanguageModel(vscode, title) {
  const models = await vscode.lm.selectChatModels({});
  if (!models?.length) return null;
  const choices = models.map((model) => ({
    label: model.name ?? model.family ?? model.id,
    description: `${model.vendor ?? 'unknown vendor'}${model.id ? ` / ${model.id}` : ''}`,
    model
  }));
  const selected = await vscode.window.showQuickPick(choices, {
    title,
    placeHolder: 'Source is not sent until you approve the exact scan or proposal context.'
  });
  return selected?.model ?? null;
}

module.exports = { selectLanguageModel };
