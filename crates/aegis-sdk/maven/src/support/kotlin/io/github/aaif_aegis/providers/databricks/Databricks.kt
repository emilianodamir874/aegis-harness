package io.github.aaif_aegis.providers.databricks

public fun provider(host: String, token: String): io.github.aaif_aegis.Provider =
    io.github.aaif_aegis.databricksProvider(host, token)

public fun defaultModel(): String = io.github.aaif_aegis.databricksDefaultModel()
