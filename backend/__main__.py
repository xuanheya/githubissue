import argparse

import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=43117)
    args = parser.parse_args()
    uvicorn.run(
        "backend.app:create_app",
        factory=True,
        host="127.0.0.1",
        port=args.port,
        access_log=False,
        proxy_headers=False,
    )
