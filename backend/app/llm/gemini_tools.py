"""Our canonical tool schemas, in the shape Gemini accepts.

Lives on its own because two very different callers need the same list: the
text orchestrator (app/llm/gemini_llm.py) and the live audio session
(app/live.py). They are separate conversations with separate contexts — that
separation is deliberate — but they must reach exactly the same tools, or the
assistant would be able to do things by voice it cannot do by typing, and the
other way round.
"""
from __future__ import annotations

from typing import Any

from google.genai import types

from app.tools import TOOLS


def to_gemini_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Convert our canonical JSON-schema dicts to Gemini's OpenAPI subset:
    drop `additionalProperties` (unsupported) and uppercase `type` values."""
    out: dict[str, Any] = {}
    for key, value in schema.items():
        if key == "additionalProperties":
            continue
        if key == "type" and isinstance(value, str):
            out[key] = value.upper()
        elif key == "properties" and isinstance(value, dict):
            out[key] = {k: to_gemini_schema(v) for k, v in value.items()}
        elif key == "items" and isinstance(value, dict):
            out[key] = to_gemini_schema(value)
        else:
            out[key] = value
    return out


def function_declarations() -> list[types.FunctionDeclaration]:
    decls = []
    for tool in TOOLS:
        schema = tool["input_schema"]
        params = to_gemini_schema(schema) if schema.get("properties") else None
        decls.append(
            types.FunctionDeclaration(
                name=tool["name"],
                description=tool["description"],
                parameters=params,
            )
        )
    return decls


def declarations_as_json() -> list[dict[str, Any]]:
    """The same declarations as plain JSON, for a client that has to put them
    in its own `setup` message.

    The browser echoes what the server minted the token with, rather than
    keeping its own copy: a list that drifted would be a live session offering
    tools this server does not implement.
    """
    out: list[dict[str, Any]] = []
    for tool in TOOLS:
        schema = tool["input_schema"]
        decl: dict[str, Any] = {
            "name": tool["name"],
            "description": tool["description"],
        }
        if schema.get("properties"):
            decl["parameters"] = to_gemini_schema(schema)
        out.append(decl)
    return out
