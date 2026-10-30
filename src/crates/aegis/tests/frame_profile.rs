//! End-to-end of the frame profile through the real storage layer.
//!
//! This covers the seam the unit tests do not: `set_frame_profile` writes extension state into the
//! session row, and reading the session back resolves the phrase. If this passes, `run_prompt_turn`
//! finds the profile at runtime; the prepend itself is unit-tested in the acp module.

use aegis::config::AegisMode;
use aegis::session::{FrameProfileState, SessionManager, SessionType};

#[tokio::test]
async fn frame_profile_persists_through_the_session_store() {
    let temp = tempfile::tempdir().expect("temp dir");
    let manager = SessionManager::new(temp.path().join("sessions"));

    let session = manager
        .create_session(
            temp.path().to_path_buf(),
            "frame profile test".to_string(),
            SessionType::Hidden,
            AegisMode::default(),
        )
        .await
        .expect("create session");

    // No profile yet: nothing is prepended.
    let before = manager.get_session(&session.id, false).await.expect("get");
    assert!(FrameProfileState::of(&before).phrase().is_none());

    manager
        .set_frame_profile(&session.id, "fiction")
        .await
        .expect("set profile");

    let after = manager.get_session(&session.id, false).await.expect("get");
    let state = FrameProfileState::of(&after);
    assert_eq!(state.profile, "fiction");
    assert!(state.phrase().expect("phrase").contains("novela"));

    // Switching back to work clears the prefix without losing the extension state mechanism.
    manager
        .set_frame_profile(&session.id, "work")
        .await
        .expect("set work");
    let cleared = manager.get_session(&session.id, false).await.expect("get");
    assert!(FrameProfileState::of(&cleared).phrase().is_none());
}
