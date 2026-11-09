# %% [markdown]
# # SignatureAI — Phase 7: signature similarity (SSIM baseline → ImageNet ResNet18 → Siamese ResNet18)
#
# **Question:** given a *reference* signature and a *candidate*, is the candidate written by the same person?
#
# * Data: **CEDAR** (55 writers × 24 genuine + 24 skilled forgeries) from the Hugging Face dataset
#   `1aurent/individuality-of-handwriting`. CEDAR is a research dataset: use it for evaluation/education and cite it.
# * Splits are **writer-disjoint** (train / val / test writers never overlap), so the test measures new people.
# * Three methods, same pairs, same metrics: **SSIM**, **ImageNet ResNet18 cosine** (what the API serves today),
#   **Siamese ResNet18** fine-tuned with a triplet loss (hard negatives = skilled forgeries).
# * Threshold chosen on **validation** (EER point), applied once to **test**. Reported separately for
#   *skilled forgeries* (same name, different writer) and *random forgeries* (another person's signature).
# * The Siamese weights + threshold go to S3 (`signatureai/similarity/…`) for the API (`SIMILARITY_WEIGHTS_PATH`).
#
# Runs on Colab or Kaggle (GPU recommended; ~10–20 min on a T4).

# %%
# %pip -q install "datasets>=2.19" comet_ml boto3 scikit-image scikit-learn

# %%
import os, sys, io, json, math, time, random, hashlib, datetime, uuid
from pathlib import Path
from collections import defaultdict
import numpy as np, pandas as pd
import torch, torchvision
import matplotlib.pyplot as plt
from PIL import Image, ImageOps
from skimage.metrics import structural_similarity
from sklearn.metrics import roc_auc_score, roc_curve

SEED = 42
HF_SIGNATURE_DATASET = '1aurent/individuality-of-handwriting'
WRITER_SPLIT = (35, 10, 10)          # train / val / test writers (55 in total)
PAIRS_PER_WRITER = 60                 # per pair type per writer for evaluation
IMG = 224
EPOCHS = 15
TRIPLETS_PER_EPOCH = 3000
BATCH_SIZE = 32
LR = 1e-4
MARGIN = 0.3                          # triplet margin on cosine distance
PATIENCE = 4                          # early stopping on validation EER
SKILLED_NEGATIVE_FRACTION = 0.5       # share of negatives that are skilled forgeries (hard negatives)
USE_COMET = True
COMET_PROJECT = 'signature-ai-similarity'
UPLOAD_TO_S3 = True
S3_PREFIX = 'signatureai/similarity'
OUT_DIR = Path('/kaggle/working' if os.path.exists('/kaggle/working') else '/content/similarity_run' if os.path.exists('/content') else 'similarity_run')
OUT_DIR.mkdir(parents=True, exist_ok=True)
RUN_VERSION = 'v' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
random.seed(SEED); np.random.seed(SEED); torch.manual_seed(SEED)
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print('Run', RUN_VERSION, '| device', device)

# %%
def secret_or_none(name):
    """Env var -> Colab Secrets -> Kaggle Secrets -> private Kaggle 'pipeline_secrets.json' dataset."""
    value = os.environ.get(name)
    if value:
        return value
    try:
        from google.colab import userdata
        return userdata.get(name)
    except Exception:
        pass
    try:
        from kaggle_secrets import UserSecretsClient
        return UserSecretsClient().get_secret(name)
    except Exception:
        pass
    root = Path('/kaggle/input')
    if root.exists():
        for candidate in root.rglob('pipeline_secrets.json'):
            try:
                value = json.loads(candidate.read_text()).get(name)
                if value:
                    return value
            except Exception:
                pass
    return None

# %% [markdown]
# ## Data: CEDAR with writer IDs, writer-disjoint split

# %%
def load_cedar():
    """Returns a list of dicts {image: PIL, writer: int, genuine: bool}."""
    from datasets import load_dataset
    ds = load_dataset(HF_SIGNATURE_DATASET, split='train', token=secret_or_none('HF_TOKEN'))
    label_names = ds.features['label'].names               # ['original', 'forgeries']
    genuine_id = label_names.index('original')
    return [{'image': r['image'], 'writer': int(r['individual']), 'genuine': int(r['label']) == genuine_id}
            for r in ds]

if 'RECORDS' not in globals():            # tests can inject synthetic RECORDS
    RECORDS = load_cedar()
writers = sorted({r['writer'] for r in RECORDS})
rng = random.Random(SEED); rng.shuffle(writers)
n_tr, n_va, n_te = WRITER_SPLIT
assert n_tr + n_va + n_te <= len(writers), f'only {len(writers)} writers'
SPLIT_WRITERS = {'train': writers[:n_tr], 'val': writers[n_tr:n_tr + n_va], 'test': writers[n_tr + n_va:n_tr + n_va + n_te]}
assert not (set(SPLIT_WRITERS['train']) & set(SPLIT_WRITERS['val']) | set(SPLIT_WRITERS['train']) & set(SPLIT_WRITERS['test'])
            | set(SPLIT_WRITERS['val']) & set(SPLIT_WRITERS['test'])), 'writer leakage between splits'
by_writer = defaultdict(lambda: {'genuine': [], 'forged': []})
for i, r in enumerate(RECORDS):
    by_writer[r['writer']]['genuine' if r['genuine'] else 'forged'].append(i)
print({k: len(v) for k, v in SPLIT_WRITERS.items()}, '| images:', len(RECORDS),
      '| genuine:', sum(r['genuine'] for r in RECORDS), '| forged:', sum(not r['genuine'] for r in RECORDS))

# %% [markdown]
# ## Preprocessing — identical to the API (`signature_service/app/inference.py`)

# %%
MEAN = torch.tensor((0.485, 0.456, 0.406)).view(3, 1, 1)
STD = torch.tensor((0.229, 0.224, 0.225)).view(3, 1, 1)

def to_canvas(image: Image.Image) -> Image.Image:
    """Grayscale, autocontrast, pad to a white square, 224x224 (same as SignatureEmbedder._preprocess)."""
    gray = ImageOps.autocontrast(image.convert('L'))
    side = max(gray.size)
    canvas = Image.new('L', (side, side), 255)
    canvas.paste(gray, ((side - gray.width) // 2, (side - gray.height) // 2))
    return canvas.resize((IMG, IMG), Image.BILINEAR)

def to_tensor(canvas: Image.Image) -> torch.Tensor:
    t = torch.from_numpy(np.asarray(canvas.convert('RGB'), dtype=np.uint8).copy()).permute(2, 0, 1).float() / 255
    return (t - MEAN) / STD

CANVAS = [to_canvas(r['image']) for r in RECORDS]   # 2,640 small images: keep them in memory
GRAY = [np.asarray(c, dtype=np.uint8) for c in CANVAS]

# %% [markdown]
# ## Evaluation pairs (fixed, per split): genuine–genuine, genuine–skilled forgery, genuine–other writer

# %%
def make_pairs(split, per_writer=PAIRS_PER_WRITER, seed=SEED):
    rng = random.Random(f'{seed}-{split}')
    ws = SPLIT_WRITERS[split]
    pairs = []  # (i, j, same_writer, kind)
    for w in ws:
        g, f = by_writer[w]['genuine'], by_writer[w]['forged']
        for _ in range(per_writer):
            a, b = rng.sample(g, 2); pairs.append((a, b, 1, 'genuine'))
        for _ in range(per_writer):
            if f:
                pairs.append((rng.choice(g), rng.choice(f), 0, 'skilled'))
        others = [x for x in ws if x != w]
        for _ in range(per_writer):
            pairs.append((rng.choice(g), rng.choice(by_writer[rng.choice(others)]['genuine']), 0, 'random'))
    return pairs

PAIRS = {s: make_pairs(s) for s in ('val', 'test')}
print({s: len(p) for s, p in PAIRS.items()})

def metrics(scores, labels, threshold=None):
    scores, labels = np.asarray(scores, float), np.asarray(labels, int)
    fpr, tpr, thr = roc_curve(labels, scores)
    fnr = 1 - tpr
    k = int(np.nanargmin(np.abs(fnr - fpr)))
    eer, eer_thr = float((fpr[k] + fnr[k]) / 2), float(thr[k])
    t = eer_thr if threshold is None else threshold
    pred = scores >= t
    far = float((pred & (labels == 0)).sum() / max(1, (labels == 0).sum()))   # forgeries accepted
    frr = float((~pred & (labels == 1)).sum() / max(1, (labels == 1).sum()))  # genuine rejected
    return {'auc': float(roc_auc_score(labels, scores)), 'eer': eer, 'eer_threshold': eer_thr,
            'threshold_used': float(t), 'far': far, 'frr': frr, 'accuracy': float((pred == labels).mean())}

def evaluate(score_fn, split, threshold=None):
    """Metrics on all pairs and separately vs skilled / random forgeries (genuine pairs included in both)."""
    pairs = PAIRS[split]
    scores = np.array([score_fn(i, j) for i, j, _, _ in pairs])
    labels = np.array([y for _, _, y, _ in pairs]); kinds = np.array([k for *_, k in pairs])
    out = {'all': metrics(scores, labels, threshold)}
    for kind in ('skilled', 'random'):
        m = (kinds == 'genuine') | (kinds == kind)
        out[kind] = metrics(scores[m], labels[m], out['all']['threshold_used'])
    return out, scores, labels

# %% [markdown]
# ## Baseline 1 — SSIM (pixel structure, no learning)

# %%
ssim_fn = lambda i, j: structural_similarity(GRAY[i], GRAY[j], data_range=255)
ssim_val, _, _ = evaluate(ssim_fn, 'val')
ssim_test, ssim_scores, test_labels = evaluate(ssim_fn, 'test', threshold=ssim_val['all']['eer_threshold'])
print('SSIM val EER', round(ssim_val['all']['eer'], 4), '| test', json.dumps(ssim_test['all'], indent=None))

# %% [markdown]
# ## Baseline 2 — ImageNet ResNet18 cosine (what the API serves today)

# %%
def make_backbone(pretrained=True):
    weights = torchvision.models.ResNet18_Weights.DEFAULT if pretrained else None
    net = torchvision.models.resnet18(weights=weights)
    net.fc = torch.nn.Identity()
    return net.to(device)

@torch.inference_mode()
def embed_all(net, indices, batch=64):
    net.eval(); out = {}
    for k in range(0, len(indices), batch):
        chunk = indices[k:k + batch]
        x = torch.stack([to_tensor(CANVAS[i]) for i in chunk]).to(device)
        e = torch.nn.functional.normalize(net(x), dim=1).cpu()
        out.update({i: e[n] for n, i in enumerate(chunk)})
    return out

def cosine_fn(emb):
    return lambda i, j: float(torch.dot(emb[i], emb[j]))

PRETRAINED = globals().get('PRETRAINED', True)
eval_idx = sorted({i for s in PAIRS for p in PAIRS[s] for i in p[:2]})
imagenet = make_backbone(PRETRAINED)
emb0 = embed_all(imagenet, eval_idx)
base_val, _, _ = evaluate(cosine_fn(emb0), 'val')
base_test, base_scores, _ = evaluate(cosine_fn(emb0), 'test', threshold=base_val['all']['eer_threshold'])
print('ImageNet ResNet18 val EER', round(base_val['all']['eer'], 4), '| test', base_test['all'])

# %% [markdown]
# ## Siamese ResNet18 — triplet loss on cosine distance, skilled forgeries as hard negatives

# %%
comet_experiment = None
if USE_COMET and secret_or_none('COMET_API_KEY'):
    import comet_ml
    comet_experiment = comet_ml.start(api_key=secret_or_none('COMET_API_KEY'), workspace=secret_or_none('COMET_WORKSPACE') or None,
                                      project_name=COMET_PROJECT, mode='create',
                                      experiment_config=comet_ml.ExperimentConfig(name=RUN_VERSION, tags=['similarity', 'siamese', 'resnet18', 'cedar']))
    comet_experiment.log_parameters({'dataset': HF_SIGNATURE_DATASET, 'writer_split': str(WRITER_SPLIT), 'epochs': EPOCHS,
                                     'triplets_per_epoch': TRIPLETS_PER_EPOCH, 'batch_size': BATCH_SIZE, 'lr': LR,
                                     'margin': MARGIN, 'skilled_negative_fraction': SKILLED_NEGATIVE_FRACTION, 'img': IMG})
    comet_experiment.log_metrics({'ssim_val_eer': ssim_val['all']['eer'], 'imagenet_val_eer': base_val['all']['eer']})

augment = torchvision.transforms.RandomAffine(degrees=4, translate=(0.04, 0.04), scale=(0.92, 1.08), fill=255)

def sample_triplet(rng):
    w = rng.choice(SPLIT_WRITERS['train'])
    a, p = rng.sample(by_writer[w]['genuine'], 2)
    if by_writer[w]['forged'] and rng.random() < SKILLED_NEGATIVE_FRACTION:
        n = rng.choice(by_writer[w]['forged'])
    else:
        other = rng.choice([x for x in SPLIT_WRITERS['train'] if x != w])
        n = rng.choice(by_writer[other]['genuine'])
    return a, p, n

def batch_tensor(indices):
    return torch.stack([to_tensor(augment(CANVAS[i])) for i in indices]).to(device)

siamese = make_backbone(PRETRAINED)
optimizer = torch.optim.AdamW(siamese.parameters(), lr=LR, weight_decay=1e-4)
scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS)
loss_fn = torch.nn.TripletMarginWithDistanceLoss(
    distance_function=lambda x, y: 1 - torch.nn.functional.cosine_similarity(x, y), margin=MARGIN)
best_eer, best_epoch, bad, history = float('inf'), 0, 0, []
best_path = OUT_DIR / 'siamese_resnet18_best.pt'
rng_train = random.Random(SEED)
for epoch in range(1, EPOCHS + 1):
    siamese.train(); losses = []; t0 = time.time()
    for _ in range(max(1, TRIPLETS_PER_EPOCH // BATCH_SIZE)):
        trip = [sample_triplet(rng_train) for _ in range(BATCH_SIZE)]
        a, p, n = (batch_tensor([t[k] for t in trip]) for k in range(3))
        ea, ep, en = (torch.nn.functional.normalize(siamese(x), dim=1) for x in (a, p, n))
        loss = loss_fn(ea, ep, en)
        optimizer.zero_grad(set_to_none=True); loss.backward(); optimizer.step()
        losses.append(float(loss.detach()))
    scheduler.step()
    val, _, _ = evaluate(cosine_fn(embed_all(siamese, eval_idx)), 'val')
    row = {'epoch': epoch, 'train_loss': float(np.mean(losses)), 'val_eer': val['all']['eer'], 'val_auc': val['all']['auc'],
           'val_eer_skilled': val['skilled']['eer'], 'val_eer_random': val['random']['eer'],
           'lr': scheduler.get_last_lr()[0], 'seconds': round(time.time() - t0, 1)}
    history.append(row); print(row)
    if comet_experiment:
        comet_experiment.log_metrics({k: v for k, v in row.items() if k != 'epoch'}, step=epoch, epoch=epoch)
    if row['val_eer'] < best_eer - 1e-4:
        best_eer, best_epoch, bad = row['val_eer'], epoch, 0
        torch.save(siamese.state_dict(), best_path)
    else:
        bad += 1
        if bad >= PATIENCE:
            print('early stopping at epoch', epoch, '| best epoch', best_epoch); break
pd.DataFrame(history).to_csv(OUT_DIR / 'siamese_history.csv', index=False)

# %% [markdown]
# ## Threshold on validation, then the held-out TEST writers once

# %%
siamese.load_state_dict(torch.load(best_path, map_location=device))
emb_s = embed_all(siamese, eval_idx)
siam_val, _, _ = evaluate(cosine_fn(emb_s), 'val')
SIMILARITY_THRESHOLD = siam_val['all']['eer_threshold']
siam_test, siam_scores, _ = evaluate(cosine_fn(emb_s), 'test', threshold=SIMILARITY_THRESHOLD)

rows = []
for name, v, t in [('SSIM', ssim_val, ssim_test), ('ResNet18 ImageNet (current API)', base_val, base_test),
                   ('Siamese ResNet18 (ours)', siam_val, siam_test)]:
    rows.append({'method': name, 'val_EER': v['all']['eer'], 'threshold (from val)': t['all']['threshold_used'],
                 'test_AUC': t['all']['auc'], 'test_EER': t['all']['eer'], 'test_FAR': t['all']['far'],
                 'test_FRR': t['all']['frr'], 'test_acc': t['all']['accuracy'],
                 'test_EER_skilled': t['skilled']['eer'], 'test_EER_random': t['random']['eer']})
comparison = pd.DataFrame(rows).round(4)
print(comparison.to_string(index=False))
comparison.to_csv(OUT_DIR / 'similarity_comparison.csv', index=False)

fig, ax = plt.subplots(1, 2, figsize=(13, 4.5))
for name, s in [('SSIM', ssim_scores), ('ResNet18 ImageNet', base_scores), ('Siamese ResNet18', siam_scores)]:
    fpr, tpr, _ = roc_curve(test_labels, s); ax[0].plot(fpr, tpr, label=f'{name} (AUC {roc_auc_score(test_labels, s):.3f})')
ax[0].plot([0, 1], [0, 1], 'k--', lw=.8); ax[0].set(xlabel='False accept rate', ylabel='True accept rate', title='Test ROC (unseen writers)')
ax[0].legend()
h = pd.DataFrame(history)
ax[1].plot(h.epoch, h.val_eer, marker='o', label='val EER'); ax[1].plot(h.epoch, h.val_eer_skilled, marker='o', label='val EER skilled')
ax[1].set(xlabel='Epoch', ylabel='EER (lower is better)', title='Siamese training'); ax[1].legend(); ax[1].grid(True)
plt.tight_layout(); plt.savefig(OUT_DIR / 'similarity_results.png', dpi=160); plt.show()

# %% [markdown]
# ## Export for the API + S3 registry

# %%
weights_file = OUT_DIR / 'siamese_resnet18.pt'
torch.save({k: v.cpu() for k, v in siamese.state_dict().items()}, weights_file)
sha = hashlib.sha256(weights_file.read_bytes()).hexdigest()
report = {'version': RUN_VERSION, 'dataset': HF_SIGNATURE_DATASET, 'writers': {k: len(v) for k, v in SPLIT_WRITERS.items()},
          'best_epoch': best_epoch, 'recommended_threshold': SIMILARITY_THRESHOLD, 'weights_sha256': sha,
          'preprocessing': 'grayscale, autocontrast, pad to white square, 224x224, ImageNet normalisation',
          'comparison': rows, 'note': 'CEDAR has 55 writers; test = 10 unseen writers, so expect a few % variance.'}
(OUT_DIR / 'similarity_report.json').write_text(json.dumps(report, indent=2))
print(json.dumps({k: report[k] for k in ('version', 'best_epoch', 'recommended_threshold', 'weights_sha256')}, indent=2))

if UPLOAD_TO_S3 and secret_or_none('AWS_S3_BUCKET'):
    import boto3
    s3 = boto3.client('s3', aws_access_key_id=secret_or_none('AWS_ACCESS_KEY_ID'),
                      aws_secret_access_key=secret_or_none('AWS_SECRET_ACCESS_KEY'), region_name=secret_or_none('AWS_REGION'))
    bucket, base = secret_or_none('AWS_S3_BUCKET'), f"{S3_PREFIX}/versions/{RUN_VERSION}"
    for f in ('siamese_resnet18.pt', 'similarity_report.json', 'similarity_comparison.csv', 'similarity_results.png'):
        s3.upload_file(str(OUT_DIR / f), bucket, f'{base}/{f}', ExtraArgs={'ServerSideEncryption': 'AES256'})
    alias = {'version': RUN_VERSION, 'weights_key': f'{base}/siamese_resnet18.pt', 'sha256': sha,
             'recommended_threshold': SIMILARITY_THRESHOLD}
    s3.put_object(Bucket=bucket, Key=f'{S3_PREFIX}/aliases/latest.json', Body=json.dumps(alias, indent=2).encode(),
                  ContentType='application/json', ServerSideEncryption='AES256')
    print('S3:', f's3://{bucket}/{base}/siamese_resnet18.pt')

if comet_experiment:
    comet_experiment.log_metrics({'test_eer': siam_test['all']['eer'], 'test_auc': siam_test['all']['auc'],
                                  'test_far': siam_test['all']['far'], 'test_frr': siam_test['all']['frr'],
                                  'test_eer_skilled': siam_test['skilled']['eer'], 'test_eer_random': siam_test['random']['eer'],
                                  'recommended_threshold': SIMILARITY_THRESHOLD,
                                  'ssim_test_eer': ssim_test['all']['eer'], 'imagenet_test_eer': base_test['all']['eer']})
    comet_experiment.log_table('similarity_comparison.csv', tabular_data=comparison)
    comet_experiment.log_image(str(OUT_DIR / 'similarity_results.png'), name='similarity_results')
    comet_experiment.log_asset(str(OUT_DIR / 'similarity_report.json'))
    comet_experiment.end()
print('API settings ->  SIMILARITY_WEIGHTS_PATH=<path to siamese_resnet18.pt>   SIMILARITY_MATCH_THRESHOLD =', round(SIMILARITY_THRESHOLD, 4))
