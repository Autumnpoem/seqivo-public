// Copyright 2014-2021 The winit contributors
// Copyright 2021-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// Seqivo modification (2026-10-24): guard native Quit requests; see src-tauri/vendor/README.md.

use crate::{
  platform::macos::ActivationPolicy,
  platform_impl::platform::{
    app_state::AppState,
    ffi::{id, BOOL, YES},
  },
};

use objc2::runtime::{
  AnyClass as Class, AnyObject as Object, Bool, ClassBuilder as ClassDecl, Sel,
};
use objc2_app_kit::NSApplicationTerminateReply;
use objc2_foundation::{
  NSArray, NSError, NSString, NSUserActivity, NSUserActivityTypeBrowsingWeb, NSURL,
};
use once_cell::sync::Lazy;
use std::{
  cell::{RefCell, RefMut},
  ffi::{CStr, CString},
  os::raw::c_void,
  sync::{Mutex, OnceLock},
  time::Instant,
};

const AUX_DELEGATE_STATE_NAME: &str = "auxState";

type TerminationHandler = dyn Fn() + Send + Sync + 'static;
static TERMINATION_HANDLER: OnceLock<Box<TerminationHandler>> = OnceLock::new();

pub(crate) fn set_application_should_terminate_handler(
  handler: Box<TerminationHandler>,
) -> Result<(), &'static str> {
  if objc2_foundation::MainThreadMarker::new().is_none() {
    return Err("native Quit handler must be installed on the main thread");
  }
  TERMINATION_HANDLER.set(handler).map_err(|_| "native Quit handler is already installed")
}

fn termination_reply(handler: Option<&TerminationHandler>) -> NSApplicationTerminateReply {
  let Some(handler) = handler else { return NSApplicationTerminateReply::TerminateNow; };
  // Never unwind over AppKit's C ABI, and never permit termination because the
  // app's handler failed. Completion is decided by the app's shutdown proof.
  if std::panic::catch_unwind(std::panic::AssertUnwindSafe(handler)).is_err() {
    log::error!("native Quit handler panicked; termination remains cancelled");
  }
  NSApplicationTerminateReply::TerminateCancel
}

pub struct AuxDelegateState {
  /// We store this value in order to be able to defer setting the activation policy until
  /// after the app has finished launching. If the activation policy is set earlier, the
  /// menubar is initially unresponsive on macOS 10.15 for example.
  pub activation_policy: ActivationPolicy,

  /// Whether the application is visible in the dock.
  pub dock_visibility: bool,
  pub last_dock_show: Mutex<Option<Instant>>,

  pub activate_ignoring_other_apps: bool,
}

pub struct AppDelegateClass(pub *const Class);
unsafe impl Send for AppDelegateClass {}
unsafe impl Sync for AppDelegateClass {}

pub static APP_DELEGATE_CLASS: Lazy<AppDelegateClass> = Lazy::new(|| unsafe {
  let superclass = class!(NSResponder);
  let mut decl = ClassDecl::new(
    CStr::from_bytes_with_nul(b"TaoAppDelegateParent\0").unwrap(),
    superclass,
  )
  .unwrap();

  decl.add_class_method(sel!(new), new as extern "C" fn(_, _) -> _);
  decl.add_method(sel!(dealloc), dealloc as extern "C" fn(_, _));

  decl.add_method(
    sel!(applicationDidFinishLaunching:),
    did_finish_launching as extern "C" fn(_, _, _),
  );
  decl.add_method(
    sel!(applicationShouldTerminate:),
    application_should_terminate as extern "C" fn(_, _, _) -> _,
  );
  decl.add_method(
    sel!(applicationWillTerminate:),
    application_will_terminate as extern "C" fn(_, _, _),
  );
  decl.add_method(
    sel!(application:openURLs:),
    application_open_urls as extern "C" fn(_, _, _, _),
  );
  decl.add_method(
    sel!(application:willContinueUserActivityWithType:),
    application_will_continue_user_activity_with_type as extern "C" fn(_, _, _, _) -> _,
  );
  decl.add_method(
    sel!(application:continueUserActivity:restorationHandler:),
    application_continue_user_activity as extern "C" fn(_, _, _, _, _) -> _,
  );
  decl.add_method(
    sel!(applicationShouldHandleReopen:hasVisibleWindows:),
    application_should_handle_reopen as extern "C" fn(_, _, _, _) -> _,
  );
  decl.add_method(
    sel!(applicationSupportsSecureRestorableState:),
    application_supports_secure_restorable_state as extern "C" fn(_, _, _) -> _,
  );
  decl.add_ivar::<*mut c_void>(&CString::new(AUX_DELEGATE_STATE_NAME).unwrap());

  AppDelegateClass(decl.register())
});

/// Safety: Assumes that Object is an instance of APP_DELEGATE_CLASS
#[allow(deprecated)] // TODO: Use define_class!
pub unsafe fn get_aux_state_mut(this: &Object) -> RefMut<'_, AuxDelegateState> {
  let ptr: *mut c_void = *this.get_ivar(AUX_DELEGATE_STATE_NAME);
  // Watch out that this needs to be the correct type
  (*(ptr as *mut RefCell<AuxDelegateState>)).borrow_mut()
}

extern "C" fn new(class: &Class, _: Sel) -> id {
  #[allow(deprecated)] // TODO: Use define_class!
  unsafe {
    let this: id = msg_send![class, alloc];
    let this: id = msg_send![this, init];
    *(*this).get_mut_ivar(AUX_DELEGATE_STATE_NAME) =
      Box::into_raw(Box::new(RefCell::new(AuxDelegateState {
        activation_policy: ActivationPolicy::Regular,
        activate_ignoring_other_apps: true,
        dock_visibility: true,
        last_dock_show: Mutex::new(None),
      }))) as *mut c_void;
    this
  }
}

extern "C" fn dealloc(this: &Object, _: Sel) {
  #[allow(deprecated)] // TODO: Use define_class!
  unsafe {
    let state_ptr: *mut c_void = *(this.get_ivar(AUX_DELEGATE_STATE_NAME));
    // As soon as the box is constructed it is immediately dropped, releasing the underlying
    // memory
    drop(Box::from_raw(state_ptr as *mut RefCell<AuxDelegateState>));
  }
}

extern "C" fn did_finish_launching(this: &Object, _: Sel, _: id) {
  trace!("Triggered `applicationDidFinishLaunching`");
  AppState::launched(this);
  trace!("Completed `applicationDidFinishLaunching`");
}

extern "C" fn application_will_terminate(_: &Object, _: Sel, _: id) {
  trace!("Triggered `applicationWillTerminate`");
  AppState::exit();
  trace!("Completed `applicationWillTerminate`");
}

extern "C" fn application_should_terminate(_: &Object, _: Sel, _: id) -> NSApplicationTerminateReply {
  termination_reply(TERMINATION_HANDLER.get().map(|handler| &**handler))
}

#[cfg(test)]
mod seqivo_termination_tests {
  use super::*;
  use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

  #[test]
  fn no_handler_preserves_appkit_default() {
    assert_eq!(termination_reply(None), NSApplicationTerminateReply::TerminateNow);
  }

  #[test]
  fn every_os_quit_is_cancelled_and_reported_without_waiting() {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let handler = move || { observed.fetch_add(1, Ordering::SeqCst); };
    for _ in 0..3 {
      assert_eq!(termination_reply(Some(&handler)), NSApplicationTerminateReply::TerminateCancel);
    }
    // The app's existing Shutdown gate, not this delegate, deduplicates work.
    assert_eq!(calls.load(Ordering::SeqCst), 3);
  }

  #[test]
  fn a_panicking_handler_cannot_approve_termination_or_unwind_into_appkit() {
    let handler = || panic!("controlled handler failure");
    assert_eq!(termination_reply(Some(&handler)), NSApplicationTerminateReply::TerminateCancel);
  }
}

extern "C" fn application_open_urls(_: &Object, _: Sel, _: id, urls: &NSArray<NSURL>) {
  trace!("Trigger `application:openURLs:`");

  let urls = unsafe {
    (0..urls.count())
      .flat_map(|i| url::Url::parse(&urls.objectAtIndex(i).absoluteString().unwrap().to_string()))
      .collect::<Vec<_>>()
  };
  trace!("Get `application:openURLs:` URLs: {:?}", urls);
  AppState::open_urls(urls);
  trace!("Completed `application:openURLs:`");
}

extern "C" fn application_will_continue_user_activity_with_type(
  _: &Object,
  _: Sel,
  _: id,
  user_activity_type: &NSString,
) -> Bool {
  trace!("Trigger `application:willContinueUserActivityWithType:`");
  let result = unsafe { Bool::new(user_activity_type == NSUserActivityTypeBrowsingWeb) };
  trace!("Completed `application:willContinueUserActivityWithType:`");
  result
}

extern "C" fn application_continue_user_activity(
  _: &Object,
  _: Sel,
  _: id,
  user_activity: &NSUserActivity,
  _restoration_handler: &block2::Block<dyn Fn(*mut NSError)>,
) -> Bool {
  trace!("Trigger `application:continueUserActivity:restorationHandler:`");
  let url = unsafe {
    if user_activity
      .activityType()
      .isEqualToString(NSUserActivityTypeBrowsingWeb)
    {
      match user_activity
        .webpageURL()
        .and_then(|url| url.absoluteString())
        .and_then(|s| Some(s.to_string()))
      {
        None => {
          error!(
              "`application:continueUserActivity:restorationHandler:`: restore webbrowsing activity but url is empty"
            );
          return Bool::new(false);
        }
        Some(url_string) => match url::Url::parse(&url_string) {
          Ok(url) => url,
          Err(err) => {
            error!(
              "`application:continueUserActivity:restorationHandler:`: failed to parse url {err}"
            );
            return Bool::new(false);
          }
        },
      }
    } else {
      return Bool::new(false);
    }
  };

  AppState::open_urls(vec![url]);
  trace!("Completed `application:continueUserActivity:restorationHandler:`");
  return Bool::new(true);
}

extern "C" fn application_should_handle_reopen(
  _: &Object,
  _: Sel,
  _: id,
  has_visible_windows: BOOL,
) -> BOOL {
  trace!("Triggered `applicationShouldHandleReopen`");
  AppState::reopen(has_visible_windows.as_bool());
  trace!("Completed `applicationShouldHandleReopen`");
  has_visible_windows
}

extern "C" fn application_supports_secure_restorable_state(_: &Object, _: Sel, _: id) -> BOOL {
  trace!("Triggered `applicationSupportsSecureRestorableState`");
  trace!("Completed `applicationSupportsSecureRestorableState`");
  YES
}
