from functools import wraps
from typing import Callable

from flask import g, jsonify


def current_user():
    return getattr(g, "current_user", None)


def login_required(view: Callable):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not current_user():
            return jsonify({"success": False, "message": "本地用户未初始化"}), 500
        return view(*args, **kwargs)

    return wrapped
