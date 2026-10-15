package io.github.aaif_aegis.providers.openai

public fun provider(
    apiKey: String,
    baseUrl: String? = null,
): io.github.aaif_aegis.Provider = io.github.aaif_aegis.openaiProvider(apiKey, baseUrl)

public fun defaultModel(): String = io.github.aaif_aegis.openaiDefaultModel()
