pub use aegis_download_manager::*;

#[cfg(test)]
mod tests {
    #[cfg(feature = "local-inference")]
    #[test]
    fn local_inference_uses_same_download_manager() {
        let aegis_manager = crate::download_manager::get_download_manager() as *const _;
        let local_manager =
            crate::providers::local_inference::download_manager::get_download_manager() as *const _;

        assert_eq!(aegis_manager, local_manager);
    }
}
