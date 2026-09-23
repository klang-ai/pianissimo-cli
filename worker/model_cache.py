"""Resolve a pinned model locally before allowing a download."""


def resolve_checkpoint(model, revision, cache_dir, report):
    from huggingface_hub import hf_hub_download
    from huggingface_hub.errors import LocalEntryNotFoundError

    options = dict(repo_id=model, filename="pianissimo-sv.nemo", revision=revision, cache_dir=cache_dir)
    try:
        checkpoint = hf_hub_download(**options, local_files_only=True)
    except LocalEntryNotFoundError:
        report(f"Model is not cached. Downloading Pianissimo (2.51 GB) to {cache_dir}.")
        checkpoint = hf_hub_download(**options)
        return checkpoint, False
    report(f"Using Pianissimo cached on disk: {checkpoint}")
    return checkpoint, True
