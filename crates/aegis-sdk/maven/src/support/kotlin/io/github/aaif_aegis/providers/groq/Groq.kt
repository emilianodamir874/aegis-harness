package io.github.aaif_aegis.providers.groq

public fun provider(apiKey: String): io.github.aaif_aegis.Provider = io.github.aaif_aegis.groqProvider(apiKey)

public fun defaultModel(): String = io.github.aaif_aegis.groqDefaultModel()
