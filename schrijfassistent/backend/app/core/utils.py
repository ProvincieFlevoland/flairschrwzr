import re

def natural_sort_key(s: str):
    """
    Returns a key for natural sorting (e.g., h1, h2, h10).
    Splits the string into parts: non-digits and digits.
    """
    return [int(text) if text.isdigit() else text.lower()
            for text in re.split(r'(\d+)', str(s))]
