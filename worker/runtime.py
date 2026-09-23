"""Device selection without importing the inference stack."""


def select_device(requested, *, cuda_available, mps_available):
    if requested == "auto":
        return "cuda" if cuda_available else "mps" if mps_available else "cpu"
    if requested == "cuda" and not cuda_available:
        raise RuntimeError("CUDA is unavailable. Install CUDA-enabled PyTorch or use --device cpu.")
    if requested == "mps" and not mps_available:
        raise RuntimeError(
            "Apple GPU (MPS) is unavailable to this process. Use an MPS-enabled PyTorch build "
            "on a supported Mac, run outside a GPU-restricted sandbox, or use --device cpu."
        )
    if requested not in ("cpu", "cuda", "mps"):
        raise ValueError(f"Unknown inference device: {requested}")
    return requested
