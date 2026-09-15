// Composition root for the Pi Chat webview. Feature state lives in its controller.
import { createShell } from './chat/shell.js';
import { createConversation } from './chat/conversation.js';
import { createComposer } from './chat/composer.js';
import { createPanels } from './chat/panels.js';

const vscode = acquireVsCodeApi();
// Only conversation/streaming state is shared between rendering and submission.
const state = { isStreaming: false, messageIdCounter: 0, currentMessageId: null, accumulatedText: '' };
const shell = createShell(vscode);
const conversation = createConversation({ vscode, state, saveState: shell.saveState });
const composer = createComposer({ vscode, state,
  showError: conversation.showError,
  removeRejectedMessage: conversation.removeRejectedMessage,
  enableAutoScroll: conversation.enableAutoScroll,
});
const panels = createPanels({ vscode, isLocked: composer.isLocked });
const tools = conversation.tools;

// Host messages are routed here; controllers own their DOM and mutable state.
window.addEventListener('message', ({ data: msg }) => {
  switch (msg.type) {
    case 'init':
      shell.renderSession(msg.sessionName, msg.sessionId);
      shell.updateModel(msg);
      composer.setModelSupportsImages(msg.modelSupportsImages);
      composer.updateStreamingState(msg.state === 'streaming');
      break;
    case 'commands': composer.autocomplete.setCommands(msg.commands); break;
    case 'styleSelected':
      shell.applyStyle(msg.style);
      shell.saveState();
      break;
    case 'stats': panels.renderStats(msg.stats); break;
    case 'loadHistory': conversation.renderHistory(msg.messages || []); break;
    case 'historyLoading': composer.setHistoryLoading(msg.loading); break;
    case 'sessionsList': shell.renderSessions(msg); break;
    case 'userMessage': conversation.addUserMessage(msg.text, msg.queued, msg.images, msg.submissionId); break;
    case 'promptResult': composer.handlePromptResult(msg); break;
    case 'textDelta': conversation.appendTextDelta(msg); break;
    case 'thinkingDelta': conversation.appendThinkingDelta(msg.messageId, msg.blockIndex, msg.delta); break;
    case 'thinkingEnd': conversation.endThinking(msg.messageId, msg.blockIndex, msg.content); break;
    case 'toolStart': tools.addToolCard(msg); break;
    case 'toolUpdate': tools.updateToolCard(msg.toolCallId, msg.output); break;
    case 'toolEnd': tools.endToolCard(msg); break;
    case 'toolDiff': tools.updateToolDiff(msg); break;
    case 'editRecorded': tools.addEditCard(msg.filePath, msg.editId); break;
    case 'editAccepted': tools.settleEditCard(msg.editId, true); break;
    case 'editReverted': tools.settleEditCard(msg.editId, false); break;
    case 'editsSummary': tools.renderChangesBar(msg.pending); break;
    case 'queueUpdate': panels.renderQueue(msg.steering, msg.followUp); break;
    case 'retryStatus': panels.updateStatus('__retry', msg.text || undefined); break;
    case 'compactionStatus': panels.updateStatus('__compaction', msg.text || undefined); break;
    case 'agentStart':
      conversation.beginTurn();
      composer.updateStreamingState(true);
      break;
    case 'agentEnd':
      composer.updateStreamingState(false);
      conversation.endTurn();
      panels.renderQueue([], []);
      break;
    case 'sessionCleared':
      composer.clear();
      shell.renderSession();
      panels.clear();
      conversation.clear();
      break;
    case 'attachmentsSelected': void composer.attachments.receiveAttachments(msg); break;
    case 'clearComposer': composer.clear(); break;
    case 'fileResults': composer.autocomplete.showFileResults(msg.results); break;
    case 'setInputText': composer.setInputText(msg.text, msg.append); break;
    case 'extensionUiRequest':
      if (msg.method === 'setStatus') panels.updateStatus(msg.data.statusKey, msg.data.statusText);
      else if (msg.method === 'setWidget') panels.updateWidget(msg.data.widgetKey, msg.data.widgetLines);
      else if (['select', 'confirm', 'input', 'editor'].includes(msg.method)) panels.showDialog(msg);
      break;
    case 'error': conversation.showError(msg.message); break;
  }
});

conversation.renderWelcome();
composer.updateStreamingState(false);
vscode.postMessage({ type: 'ready' });
