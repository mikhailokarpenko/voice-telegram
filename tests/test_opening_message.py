"""BAS-237: behavioural tests for build_opening_message.

BAS-234 fixed `greeting_style` / `custom_greeting` being configurable in four
places and read in none: this service always opened with `intro_prompt`, so
selecting "custom" in the dashboard and typing a greeting changed a stored row
and nothing else. The resolver added by that fix has three branches and until
now no executed test covered any of them.

The invariant that matters most is the last one: the provider sends the opening
unconditionally as a conversation item, so an empty return makes the agent open
the call with silence.
"""

import pytest

from voice_telegram.telegram.client import build_opening_message

BASE = {
    "greeting_style": "casual",
    "custom_greeting": "",
    "intro_prompt": "",
    "agent_name": "Ada",
    "agent_company": "Acme",
}


def _opening(**overrides: str) -> str:
    return build_opening_message(**{**BASE, **overrides})


# ---- Branch 1: explicit custom greeting ----


def test_custom_style_with_a_custom_greeting_is_spoken_verbatim() -> None:
    assert _opening(greeting_style="custom", custom_greeting="Hey, Ada here.") == "Hey, Ada here."


def test_custom_greeting_outranks_intro_prompt() -> None:
    """Precedence here differs deliberately from voice-phone: that service
    speaks intro_prompt over a separate Twilio <Say> channel, this one has a
    single channel, so an explicit custom greeting must win."""
    assert (
        _opening(
            greeting_style="custom",
            custom_greeting="Hey, Ada here.",
            intro_prompt="Thanks for calling.",
        )
        == "Hey, Ada here."
    )


def test_custom_greeting_is_stripped() -> None:
    assert _opening(greeting_style="custom", custom_greeting="  Hi there.  ") == "Hi there."


@pytest.mark.parametrize("blank", ["", "   ", "\n\t "])
def test_custom_style_with_a_blank_greeting_falls_through(blank: str) -> None:
    """Selecting "custom" and leaving the box empty must not open with silence."""
    result = _opening(greeting_style="custom", custom_greeting=blank)
    assert result.strip()
    assert "Ada" in result


def test_custom_greeting_is_ignored_when_the_style_is_not_custom() -> None:
    """A greeting left behind from a previous "custom" selection must not leak
    into a casual call."""
    result = _opening(greeting_style="casual", custom_greeting="Hey, Ada here.")
    assert result != "Hey, Ada here."
    assert "casual" in result


# ---- Branch 2: intro_prompt ----


def test_intro_prompt_is_used_when_there_is_no_custom_greeting() -> None:
    assert _opening(intro_prompt="Thanks for calling Acme.") == "Thanks for calling Acme."


def test_intro_prompt_is_stripped() -> None:
    assert _opening(intro_prompt="  Thanks for calling.  ") == "Thanks for calling."


@pytest.mark.parametrize("blank", ["", "   ", "\n"])
def test_blank_intro_prompt_falls_through_to_the_styled_greeting(blank: str) -> None:
    result = _opening(intro_prompt=blank)
    assert result.strip()
    assert "Ada" in result


# ---- Branch 3: styled fallback ----


@pytest.mark.parametrize(
    "style", ["casual", "formal", "friendly", "professional"]
)
def test_each_style_reaches_the_generated_greeting(style: str) -> None:
    result = _opening(greeting_style=style)
    assert f"in a {style} tone" in result
    assert "Greet the caller as Ada" in result


def test_generated_greeting_includes_the_company_when_set() -> None:
    assert "from Acme" in _opening(agent_company="Acme")


def test_generated_greeting_omits_the_company_when_unset() -> None:
    result = _opening(agent_company="")
    assert "from" not in result
    assert "Greet the caller as Ada" in result


@pytest.mark.parametrize("empty_style", ["", "   "])
def test_empty_style_defaults_to_casual(empty_style: str) -> None:
    assert "in a casual tone" in _opening(greeting_style=empty_style)


# ---- The invariant across every branch ----


@pytest.mark.parametrize("style", ["casual", "formal", "friendly", "professional", "custom", ""])
@pytest.mark.parametrize("custom", ["", "   ", "Hey."])
@pytest.mark.parametrize("intro", ["", "   ", "Thanks for calling."])
@pytest.mark.parametrize("company", ["", "Acme"])
def test_never_returns_an_empty_opening(
    style: str, custom: str, intro: str, company: str
) -> None:
    """The provider sends the opening unconditionally as a conversation item.
    An empty one makes the agent open the call with silence."""
    result = build_opening_message(
        greeting_style=style,
        custom_greeting=custom,
        intro_prompt=intro,
        agent_name="Ada",
        agent_company=company,
    )
    assert result.strip(), (style, custom, intro, company)
