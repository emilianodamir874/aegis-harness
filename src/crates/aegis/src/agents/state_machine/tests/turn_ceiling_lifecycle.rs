use anyhow::Result;

use super::calculator_extension::{value, ADD};
use super::pipeline::MessageKind::Agent;
use super::test_pipeline;

/// A model that never stops calling tools is ended by the ceiling, and the calls it
/// made before the ceiling are kept: the point of the limit is to close the turn, not
/// to throw the work away.
#[tokio::test]
async fn turn_ceiling_closes_a_runaway_turn_and_keeps_the_work() -> Result<()> {
    let (pipeline, api) = test_pipeline().await?;
    let pipeline = pipeline.with_turn_tool_call_limit(2);
    api.on("keep calling").call(ADD, value(1));

    let result = pipeline.run(["keep calling"]).await?;

    assert_eq!(
        pipeline.calculator_total(),
        2,
        "the ceiling lets the calls below it through and stops the third"
    );
    assert!(
        api.calls()[1].input_contains("<turn-ceiling>"),
        "the model is told the ceiling is near before it is cut"
    );
    result.assert_message(-1, Agent, "reached its tool-call ceiling");
    result.assert_emitted_message_matches_persisted("reached its tool-call ceiling");

    Ok(())
}

/// The ceiling is a per-turn budget: the next turn starts from zero instead of
/// inheriting the closed turn's count.
#[tokio::test]
async fn the_ceiling_resets_on_the_next_turn() -> Result<()> {
    let (pipeline, api) = test_pipeline().await?;
    let pipeline = pipeline.with_turn_tool_call_limit(2);
    api.on("keep calling").call(ADD, value(1));
    api.on("one more").reply("done");

    let first = pipeline.run(["keep calling"]).await?;
    first.assert_message(-1, Agent, "reached its tool-call ceiling");

    let second = pipeline.run(["one more"]).await?;
    second.assert_message(-1, Agent, "done");

    Ok(())
}
