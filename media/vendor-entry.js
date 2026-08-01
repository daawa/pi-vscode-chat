// Bundled into media/vendor.js — exposes marked, hljs, and diff2html as globals for the webview.
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import * as Diff2Html from 'diff2html';

window.marked = marked;
window.hljs = hljs;
window.Diff2Html = Diff2Html;
