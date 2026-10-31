//! Readiness is a state transition, not a deadline or permission to replay work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase { Starting, Ready, Failed, Stopping }

#[derive(Debug)]
pub struct Startup { phase: Phase, revision: u64, message: Option<&'static str> }

impl Default for Startup {
    fn default() -> Self { Self { phase: Phase::Starting, revision: 0, message: None } }
}
impl Startup {
    pub fn phase(&self) -> Phase { self.phase }
    pub fn revision(&self) -> u64 { self.revision }
    pub fn message(&self) -> Option<&'static str> { self.message }
    fn transition(&mut self, phase: Phase, message: Option<&'static str>) -> bool {
        if self.phase == phase { return false; }
        self.phase = phase; self.message = message; self.revision += 1; true
    }
    pub fn ready(&mut self) -> bool {
        if self.phase != Phase::Starting { return false; }
        self.transition(Phase::Ready, None)
    }
    pub fn failed(&mut self, message: &'static str) -> bool {
        if matches!(self.phase, Phase::Failed | Phase::Stopping) { return false; }
        self.transition(Phase::Failed, Some(message))
    }
    pub fn unclean_shutdown(&mut self) -> bool {
        self.failed("上次后台停止结果尚未核实，暂时不能打开看板。历史任务和待核实状态已保留；需要先核对上次运行的任务与终端。刷新状态不会清除这些记录。")
    }
    pub fn stopping(&mut self) -> bool {
        self.transition(Phase::Stopping, Some("序程正在关闭，请等待后台停止。"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delayed_ready_changes_once_without_a_timer() {
        let mut s = Startup::default();
        assert_eq!(s.phase(), Phase::Starting); assert_eq!(s.revision(), 0);
        assert!(s.ready()); assert!(!s.ready());
        assert_eq!(s.phase(), Phase::Ready); assert_eq!(s.revision(), 1);
    }
    #[test]
    fn failure_cannot_be_erased_by_a_late_ready() {
        for was_ready in [true, false] {
            let mut s = Startup::default(); if was_ready { s.ready(); }
            assert!(s.failed("服务连接中断")); let revision = s.revision();
            assert!(!s.ready()); assert!(!s.failed("another"));
            assert_eq!(s.phase(), Phase::Failed); assert_eq!(s.revision(), revision);
            assert_eq!(s.message(), Some("服务连接中断"));
        }
    }
    #[test]
    fn quit_during_startup_never_advertises_readiness() {
        let mut s = Startup::default();
        assert!(s.stopping()); assert!(!s.stopping());
        assert!(!s.ready()); assert!(!s.failed("exited"));
        assert_eq!(s.phase(), Phase::Stopping); assert_eq!(s.revision(), 1);
    }
    #[test]
    fn unclean_lock_explanation_survives_generic_exit_and_late_ready() {
        let mut s = Startup::default();
        assert!(s.unclean_shutdown());
        let message = s.message(); let revision = s.revision();
        assert!(!s.failed("任务服务已退出，请重新打开应用。"));
        assert!(!s.ready()); assert!(!s.unclean_shutdown());
        assert_eq!(s.phase(), Phase::Failed);
        assert_eq!(s.message(), message); assert_eq!(s.revision(), revision);
    }
}
