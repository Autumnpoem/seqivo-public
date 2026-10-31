//! A request to quit is not proof that the task service stopped safely.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase { Running, Stopping, Unknown, Failed, Completed, UnverifiedExit }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Issue { Delivery, Deadline, Observation, MissingReceipt, Process }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub phase: Phase,
    pub issue: Option<Issue>,
    pub can_exit_unverified: bool,
    pub exit_code: Option<i32>,
}

impl Snapshot {
    /// A dismissed dialog should only be replaced if its displayed facts changed.
    pub fn needs_notice_after(&self, displayed: Self) -> bool {
        matches!(self.phase, Phase::Unknown | Phase::Failed) && *self != displayed
    }
}

#[derive(Default, Debug)]
pub struct Shutdown {
    requested: bool,
    receipt: bool,
    termination: Option<(Option<i32>, Option<i32>)>,
    observation_closed: bool,
    issue: Option<Issue>,
    unverified_exit: bool,
}

impl Shutdown {
    pub fn phase(&self) -> Phase {
        if self.unverified_exit { return Phase::UnverifiedExit; }
        if !self.requested { return Phase::Running; }
        match self.termination {
            Some((Some(0), None)) if self.receipt => Phase::Completed,
            Some((Some(0), None)) if self.observation_closed => Phase::Failed,
            Some((Some(0), None)) => if self.issue.is_some() { Phase::Unknown } else { Phase::Stopping },
            Some(_) => Phase::Failed,
            None => if self.issue.is_some() || self.observation_closed { Phase::Unknown } else { Phase::Stopping },
        }
    }
    /// True only for the first attempt and only if a live service may receive it.
    pub fn request_exit(&mut self) -> bool {
        if self.requested { return false; }
        self.requested = true;
        self.termination.is_none() && !self.observation_closed
    }
    pub fn accepts_requests(&self) -> bool { !self.requested }
    pub fn receipt(&mut self) { if self.requested { self.receipt = true; } }
    pub fn terminated(&mut self, code: Option<i32>, signal: Option<i32>) {
        // An actual process termination, never a closed observation channel.
        if self.termination.is_none() { self.termination = Some((code, signal)); }
    }
    pub fn observation_closed(&mut self) { self.observation_closed = true; }
    pub fn delivery_failed(&mut self) { self.issue = Some(Issue::Delivery); }
    pub fn deadline_elapsed(&mut self) { if self.requested { self.issue = Some(Issue::Deadline); } }
    pub fn issue(&self) -> Option<Issue> {
        if self.phase() == Phase::Completed { return None; }
        match self.termination {
            Some((Some(0), None)) if !self.receipt && self.observation_closed => Some(Issue::MissingReceipt),
            Some((Some(0), None)) => self.issue,
            Some(_) => Some(Issue::Process),
            None if self.observation_closed => Some(Issue::Observation),
            None => self.issue,
        }
    }
    pub fn can_exit_unverified(&self) -> bool {
        self.requested && self.termination.is_some() &&
            matches!(self.phase(), Phase::Failed | Phase::Unknown)
    }
    /// Only a separate, explicit user choice may exit without a clean-close proof.
    pub fn confirm_unverified_exit(&mut self) -> bool {
        if !self.can_exit_unverified() { return false; }
        self.unverified_exit = true;
        true
    }
    pub fn exit_code(&self) -> Option<i32> {
        match self.phase() { Phase::Completed => Some(0), Phase::UnverifiedExit => Some(1), _ => None }
    }
    pub fn snapshot(&self) -> Snapshot {
        Snapshot { phase:self.phase(), issue:self.issue(), can_exit_unverified:self.can_exit_unverified(), exit_code:self.exit_code() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_quit_sends_once_and_stops_accepting_requests() {
        let mut s = Shutdown::default();
        assert!(s.accepts_requests());
        assert!(s.request_exit());
        assert!(!s.request_exit());
        assert!(!s.accepts_requests());
        assert_eq!(s.phase(), Phase::Stopping);
        assert_eq!(s.exit_code(), None);
    }
    #[test]
    fn receipt_and_normal_termination_are_both_required_in_either_order() {
        for receipt_first in [true, false] {
            let mut s = Shutdown::default(); s.request_exit();
            if receipt_first { s.receipt(); } else { s.terminated(Some(0), None); }
            assert_eq!(s.exit_code(), None);
            if receipt_first { s.terminated(Some(0), None); } else { s.receipt(); }
            assert_eq!(s.phase(), Phase::Completed);
            assert_eq!(s.exit_code(), Some(0));
        }
    }
    #[test]
    fn failed_or_signalled_process_never_becomes_clean_even_with_a_receipt() {
        for (code, signal) in [(Some(1), None), (None, Some(9)), (Some(0), Some(15)), (None, None)] {
            let mut s = Shutdown::default(); s.request_exit(); s.receipt(); s.terminated(code, signal);
            assert_eq!(s.phase(), Phase::Failed);
            assert_eq!(s.issue(), Some(Issue::Process));
            assert_eq!(s.exit_code(), None);
        }
    }
    #[test]
    fn deadline_is_diagnostic_and_late_original_proof_can_finish() {
        let mut s = Shutdown::default(); s.request_exit(); s.deadline_elapsed();
        assert_eq!(s.phase(), Phase::Unknown);
        assert!(!s.request_exit());
        assert!(!s.can_exit_unverified());
        s.receipt(); s.terminated(Some(0), None);
        assert_eq!(s.exit_code(), Some(0));
        assert_eq!(s.issue(), None);
    }
    #[test]
    fn lost_observation_is_not_a_process_exit_proof() {
        let mut s = Shutdown::default(); s.request_exit(); s.receipt(); s.observation_closed();
        assert_eq!(s.phase(), Phase::Unknown);
        assert_eq!(s.issue(), Some(Issue::Observation));
        assert!(!s.confirm_unverified_exit());
        assert_eq!(s.exit_code(), None);
    }
    #[test]
    fn zero_exit_without_receipt_is_not_clean() {
        let mut s = Shutdown::default(); s.request_exit(); s.terminated(Some(0), None); s.observation_closed();
        assert_eq!(s.phase(), Phase::Failed);
        assert_eq!(s.issue(), Some(Issue::MissingReceipt));
        assert_eq!(s.exit_code(), None);
    }
    #[test]
    fn delivery_error_does_not_erase_late_success_or_allow_new_work() {
        let mut s = Shutdown::default(); s.request_exit(); s.delivery_failed();
        assert_eq!(s.phase(), Phase::Unknown);
        assert!(!s.accepts_requests());
        s.terminated(Some(0), None); s.receipt();
        assert_eq!(s.exit_code(), Some(0));
    }
    #[test]
    fn preexisting_backend_death_is_not_a_successful_quit() {
        let mut s = Shutdown::default(); s.terminated(Some(0), None); s.observation_closed();
        assert!(!s.request_exit());
        assert_eq!(s.phase(), Phase::Failed);
        assert_eq!(s.exit_code(), None);
    }
    #[test]
    fn unverified_exit_requires_explicit_choice_after_actual_process_exit() {
        let mut s = Shutdown::default(); s.request_exit(); s.deadline_elapsed();
        assert!(!s.confirm_unverified_exit());
        s.terminated(Some(0), None); s.observation_closed();
        assert!(s.confirm_unverified_exit());
        assert_eq!(s.exit_code(), Some(1));
        s.receipt();
        assert_eq!(s.exit_code(), Some(1));
    }
    #[test]
    fn late_termination_refreshes_an_open_wait_notice_even_without_phase_change() {
        let mut s = Shutdown::default(); s.request_exit(); s.deadline_elapsed();
        let displayed = s.snapshot();
        assert!(!displayed.can_exit_unverified);
        assert!(!displayed.needs_notice_after(displayed));
        s.terminated(Some(0), None);
        let current = s.snapshot();
        assert_eq!(displayed.phase, current.phase);
        assert!(current.can_exit_unverified);
        assert_ne!(current, displayed);
        assert!(current.needs_notice_after(displayed));
        // A fresh dialog is not endlessly redisplayed when it is dismissed.
        assert!(!current.needs_notice_after(current));
        s.observation_closed();
        assert!(s.snapshot().needs_notice_after(displayed));
    }
    #[test]
    fn a_completed_or_explicitly_abandoned_quit_does_not_reopen_a_warning() {
        for success in [true, false] {
            let mut s = Shutdown::default(); s.request_exit(); s.deadline_elapsed();
            let displayed = s.snapshot();
            s.terminated(Some(0), None);
            if success { s.receipt(); } else { s.observation_closed(); s.confirm_unverified_exit(); }
            assert!(!s.snapshot().needs_notice_after(displayed));
        }
    }
}
