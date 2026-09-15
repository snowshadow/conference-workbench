import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initializeTheme } from './lib/theme.js';
import './theme.css';
import './styles.css';
import './meeting-workspace.css';
import './clarification-reading.css';
import './dialogs.css';

initializeTheme();

class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error(error); }
  render() {
    if (this.state.error) return <main className="fatal-error"><h1>工作台暂时无法显示</h1><p>已保存的会议内容仍在本机。刷新页面后重试。</p><pre>{this.state.error.message}</pre><button className="button primary" onClick={() => location.reload()}>重新加载</button></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
