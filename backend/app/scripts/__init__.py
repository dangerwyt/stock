# -*- coding: utf-8 -*-
"""运维/自检脚本包（部署连通性检查等）。

独立包（不是 router）：这些东西要在容器里用 ``python -m app.scripts.xxx`` 直接跑，
不挂在 HTTP 上，避免把自检接口暴露成对外攻击面。
"""
