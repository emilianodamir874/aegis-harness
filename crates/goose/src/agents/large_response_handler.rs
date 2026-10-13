use crate::config::Config;
use base64::Engine as _;
use rmcp::model::{CallToolResult, ContentBlock, ErrorData};
use std::io::Write;

const DEFAULT_LARGE_TEXT_THRESHOLD: usize = 200_000;
/// Base64 characters a single tool image may carry before it is spilled to a
/// file. ~1.5 MB of base64 is ~1.1 MB of decoded image: big enough that normal
/// screenshots pass through, small enough that a full-size render cannot pin
/// megabytes in the conversation forever.
const DEFAULT_LARGE_IMAGE_THRESHOLD: usize = 1_500_000;

pub(crate) fn max_tool_response_size() -> usize {
    Config::global()
        .get_param::<usize>("GOOSE_MAX_TOOL_RESPONSE_SIZE")
        .unwrap_or(DEFAULT_LARGE_TEXT_THRESHOLD)
}

/// Threshold (base64 characters) above which a tool image is spilled to a file.
/// GOOSE_MAX_TOOL_IMAGE_BASE64_SIZE=0 disables image spilling entirely.
pub(crate) fn max_tool_image_size() -> usize {
    Config::global()
        .get_param::<usize>("GOOSE_MAX_TOOL_IMAGE_BASE64_SIZE")
        .unwrap_or(DEFAULT_LARGE_IMAGE_THRESHOLD)
}

/// Process tool response and handle large text and image content.
pub fn process_tool_response(
    response: Result<CallToolResult, ErrorData>,
) -> Result<CallToolResult, ErrorData> {
    let threshold = max_tool_response_size();
    match response {
        Ok(mut result) => {
            let mut processed_contents = Vec::new();

            for content in result.content {
                match content.as_text() {
                    Some(text_content) => {
                        // Check if text exceeds threshold
                        if text_content.text.chars().count() > threshold {
                            // Write to temp file
                            match write_large_text_to_file(&text_content.text) {
                                Ok(file_path) => {
                                    // Create a new text content with reference to the file
                                    let message = format!(
                                        "The response returned from the tool call was larger ({} characters) and is stored in the file which you can use other tools to examine or search in: {}",
                                        text_content.text.chars().count(),
                                        file_path
                                    );
                                    processed_contents.push(ContentBlock::text(message));
                                }
                                Err(e) => {
                                    // If file writing fails, include original content with warning
                                    let warning = format!(
                                        "Warning: Failed to write large response to file: {}. Showing full content instead.\n\n{}",
                                        e,
                                        text_content.text
                                    );
                                    processed_contents.push(ContentBlock::text(warning));
                                }
                            }
                        } else {
                            // Keep original content for smaller texts
                            processed_contents.push(content);
                        }
                    }
                    None => {
                        // Images are the other unbounded payload: a single
                        // read_image of a full-size render can pin megabytes of
                        // base64 in the history forever (the text cap never
                        // looked at them). Spill oversized ones to a file and
                        // leave a pointer; other content types pass through.
                        let image_threshold = max_tool_image_size();
                        let spilled = match content.as_image() {
                            Some(image)
                                if image_threshold > 0 && image.data.len() > image_threshold =>
                            {
                                match write_large_image_to_file(&image.data, &image.mime_type) {
                                    Ok(file_path) => Some(ContentBlock::text(format!(
                                        "The image returned from the tool call was larger ({} base64 characters, {}) and is stored in the file which you can use other tools to examine: {}",
                                        image.data.len(),
                                        image.mime_type,
                                        file_path
                                    ))),
                                    Err(e) => {
                                        tracing::warn!(
                                            %e,
                                            "Failed to spill an oversized tool image to a file"
                                        );
                                        None
                                    }
                                }
                            }
                            _ => None,
                        };
                        processed_contents.push(spilled.unwrap_or(content));
                    }
                }
            }

            // Many blocks each under the threshold can still add up to a request
            // the provider refuses to accept (a 2.3 MB tool message did). When
            // the remaining text still exceeds the threshold, spill all of it
            // to a single file and leave one pointer behind.
            let remaining_total: usize = processed_contents
                .iter()
                .filter_map(|content| content.as_text())
                .map(|text| text.text.chars().count())
                .sum();
            let remaining_blocks = processed_contents
                .iter()
                .filter(|content| content.as_text().is_some())
                .count();
            if remaining_blocks > 0 && remaining_total > threshold {
                let joint = processed_contents
                    .iter()
                    .filter_map(|content| content.as_text())
                    .map(|text| text.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                let replacement = match write_large_text_to_file(&joint) {
                    Ok(file_path) => ContentBlock::text(format!(
                        "The response returned from the tool call was larger ({} characters across {} blocks) and is stored in the file which you can use other tools to examine or search in: {}",
                        remaining_total, remaining_blocks, file_path
                    )),
                    Err(e) => {
                        tracing::warn!(
                            %e,
                            "Failed to write an oversized tool response to a file"
                        );
                        ContentBlock::text(format!(
                            "Warning: Failed to write large response to file: {}. Showing full content instead.\n\n{}",
                            e, joint
                        ))
                    }
                };
                let mut rebuilt = Vec::with_capacity(processed_contents.len());
                let mut replaced = false;
                for content in processed_contents {
                    if content.as_text().is_some() {
                        if !replaced {
                            rebuilt.push(replacement.clone());
                            replaced = true;
                        }
                    } else {
                        rebuilt.push(content);
                    }
                }
                processed_contents = rebuilt;
            }

            result.content = processed_contents;
            Ok(result)
        }
        Err(e) => Err(e),
    }
}

/// Write large text content to a temporary file
fn write_large_text_to_file(content: &str) -> Result<String, std::io::Error> {
    let mut file = tempfile::Builder::new()
        .prefix("goose_mcp_response_")
        .suffix(".txt")
        .tempfile()?;
    file.write_all(content.as_bytes())?;
    let (_, file_path) = file.keep()?;

    Ok(file_path.to_string_lossy().to_string())
}

/// Write a base64 tool image, decoded, to a temporary file whose extension
/// follows the MIME type so other tools can open it directly.
fn write_large_image_to_file(base64_data: &str, mime_type: &str) -> Result<String, std::io::Error> {
    let extension = match mime_type {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "bin",
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut file = tempfile::Builder::new()
        .prefix("goose_mcp_image_")
        .suffix(&format!(".{extension}"))
        .tempfile()?;
    file.write_all(&bytes)?;
    let (_, file_path) = file.keep()?;

    Ok(file_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::ContentBlock;
    use std::fs;
    use std::path::Path;

    fn text_of(block: &ContentBlock) -> String {
        block.as_text().expect("expected text block").text.clone()
    }

    fn spill_path(pointer: &str) -> String {
        pointer
            .rsplit_once(": ")
            .expect("pointer should end with a path")
            .1
            .trim()
            .to_string()
    }

    #[test]
    fn small_text_response_passes_through() {
        let processed =
            process_tool_response(Ok(CallToolResult::success(vec![ContentBlock::text(
                "This is a small text response",
            )])))
            .unwrap();
        assert_eq!(processed.content.len(), 1);
        assert_eq!(text_of(&processed.content[0]), "This is a small text response");
    }

    #[test]
    fn large_text_response_redirected_to_file() {
        let large_text = "a".repeat(DEFAULT_LARGE_TEXT_THRESHOLD + 1000);
        let processed =
            process_tool_response(Ok(CallToolResult::success(vec![ContentBlock::text(
                large_text.clone(),
            )])))
            .unwrap();
        assert_eq!(processed.content.len(), 1);
        let pointer = text_of(&processed.content[0]);
        assert!(pointer.contains("The response returned from the tool call was larger"));
        let path = spill_path(&pointer);
        assert_eq!(fs::read_to_string(Path::new(&path)).unwrap(), large_text);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn small_image_passes_through() {
        let image = ContentBlock::image("aGVsbG8=".to_string(), "image/png".to_string());
        let processed =
            process_tool_response(Ok(CallToolResult::success(vec![image]))).unwrap();
        assert_eq!(processed.content.len(), 1);
        let kept = processed.content[0].as_image().expect("image kept");
        assert_eq!(kept.mime_type, "image/png");
    }

    #[test]
    fn oversized_image_is_spilled_to_a_file() {
        // 1.2 MB of decoded bytes encodes to ~1.6 MB of base64, over the
        // default image threshold.
        let decoded = vec![7u8; 1_200_000];
        let base64_data =
            base64::engine::general_purpose::STANDARD.encode(&decoded);
        assert!(base64_data.len() > DEFAULT_LARGE_IMAGE_THRESHOLD);

        let image = ContentBlock::image(base64_data.clone(), "image/png".to_string());
        let processed =
            process_tool_response(Ok(CallToolResult::success(vec![image]))).unwrap();

        assert_eq!(processed.content.len(), 1);
        let pointer = text_of(&processed.content[0]);
        assert!(
            pointer.contains("The image returned from the tool call was larger"),
            "unexpected pointer: {pointer}"
        );
        let path = spill_path(&pointer);
        assert!(path.ends_with(".png"), "path should keep the image extension: {path}");
        let bytes = fs::read(Path::new(&path)).unwrap();
        assert_eq!(bytes.len(), 1_200_000);
        assert!(bytes.iter().all(|b| *b == 7));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn text_and_image_mix_is_handled_independently() {
        let large_text = "a".repeat(DEFAULT_LARGE_TEXT_THRESHOLD + 1000);
        let base64_data = base64::engine::general_purpose::STANDARD
            .encode(vec![3u8; 1_200_000]);
        let processed = process_tool_response(Ok(CallToolResult::success(vec![
            ContentBlock::text("Small text"),
            ContentBlock::text(large_text),
            ContentBlock::image(base64_data, "image/jpeg".to_string()),
        ])))
        .unwrap();

        assert_eq!(processed.content.len(), 3);
        assert_eq!(text_of(&processed.content[0]), "Small text");
        let text_pointer = text_of(&processed.content[1]);
        assert!(text_pointer.contains("The response returned from the tool call was larger"));
        let image_pointer = text_of(&processed.content[2]);
        assert!(image_pointer.contains("The image returned from the tool call was larger"));
        fs::remove_file(spill_path(&text_pointer)).unwrap();
        fs::remove_file(spill_path(&image_pointer)).unwrap();
    }

    #[test]
    fn error_response_passes_through() {
        use rmcp::model::{ErrorCode, ErrorData};
        use std::borrow::Cow;
        let error = ErrorData {
            code: ErrorCode::INTERNAL_ERROR,
            message: Cow::from("Test error"),
            data: None,
        };
        assert!(process_tool_response(Err(error)).is_err());
    }
}
