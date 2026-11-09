import fs from "node:fs";
import path from "node:path";

const md = (source) => ({ cell_type: "markdown", metadata: {}, source });
const code = (source) => ({ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source });

const cells = [
  md(`# SignatureAI — Kaggle Siamese Signature Verification

This notebook trains and evaluates a **writer-independent signature similarity model** on CEDAR.

Pipeline:

1. Load CEDAR from Hugging Face (55 writers, genuine + skilled forgeries).
2. Create deterministic, writer-disjoint train/validation/test splits.
3. Evaluate an SSIM baseline.
4. Evaluate the current ImageNet ResNet18 cosine baseline.
5. Fine-tune a Siamese/metric-learning ResNet18 with triplet loss.
6. Select the operating threshold on validation writers only.
7. Evaluate held-out test writers once with AUC, EER, FAR, FRR and accuracy.
8. Export weights, reports and plots to \`/kaggle/working\`.
9. Optionally log to Comet and upload an immutable model version + \`latest\` alias to S3.

## Kaggle settings before Run All

- **Accelerator:** GPU T4 x2, T4, or P100 (one GPU is used).
- **Internet:** On (needed for Hugging Face data, packages, and pretrained ResNet18 weights).
- Optional Kaggle secrets: \`COMET_API_KEY\`, \`COMET_WORKSPACE\`, \`AWS_ACCESS_KEY_ID\`,
  \`AWS_SECRET_ACCESS_KEY\`, \`AWS_REGION\`, \`AWS_S3_BUCKET\`, and \`HF_TOKEN\`.

The Hugging Face dataset currently declares its license as **unknown**. Use it for the course/research task,
retain the dataset citation, and review the original CEDAR terms before commercial use.
`),

  code(`# Cell 1 — install only the packages Kaggle may not already provide
%pip install -q "datasets>=2.19,<5" "comet_ml>=3.44" "boto3>=1.34" "scikit-image>=0.22" "scikit-learn>=1.4"
`),

  code(`# Cell 2 — imports, Kaggle runtime check, GPU information and deterministic seeds
import os
import io
import json
import math
import time
import random
import hashlib
import datetime
import uuid
import shutil
from pathlib import Path
from collections import defaultdict

import numpy as np
import pandas as pd
import torch
import torchvision
import matplotlib.pyplot as plt
from PIL import Image, ImageOps
from tqdm.auto import tqdm
from skimage.metrics import structural_similarity
from sklearn.metrics import roc_auc_score, roc_curve

assert Path('/kaggle/working').exists(), 'This notebook is the Kaggle version; run it inside Kaggle.'

SEED = 42
random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)
if torch.cuda.is_available():
    torch.cuda.manual_seed_all(SEED)
    torch.backends.cudnn.benchmark = True

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print('Python:', os.sys.version.split()[0])
print('PyTorch:', torch.__version__)
print('Device:', device)
if torch.cuda.is_available():
    print('GPU:', torch.cuda.get_device_name(0))
    print('GPU memory GB:', round(torch.cuda.get_device_properties(0).total_memory / 1024**3, 2))
else:
    print('WARNING: GPU is disabled. Kaggle Settings -> Accelerator -> GPU, then restart the session.')
`),

  code(`# Cell 3 — experiment configuration
HF_SIGNATURE_DATASET = '1aurent/individuality-of-handwriting'
HF_REVISION = 'main'
WRITER_SPLIT = (35, 10, 10)          # train / validation / test writers
PAIRS_PER_WRITER = 60                # per pair type for validation/test evaluation
IMG_SIZE = 224
EPOCHS = 15
TRIPLETS_PER_EPOCH = 3000
BATCH_SIZE = 32
EMBED_BATCH_SIZE = 128
LEARNING_RATE = 1e-4
WEIGHT_DECAY = 1e-4
TRIPLET_MARGIN = 0.30                 # margin on cosine distance
EARLY_STOPPING_PATIENCE = 4           # monitor validation EER (lower is better)
EARLY_STOPPING_MIN_DELTA = 1e-4
SKILLED_NEGATIVE_FRACTION = 0.50
PRETRAINED = True

USE_COMET = True
COMET_PROJECT = 'signature-ai-similarity'
UPLOAD_TO_S3 = True
S3_PREFIX = 'signatureai/similarity'
S3_ALIAS = 'latest'

RUN_VERSION = 'v' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
OUT_DIR = Path('/kaggle/working/signature_similarity')
OUT_DIR.mkdir(parents=True, exist_ok=True)

print('Run version:', RUN_VERSION)
print('Output directory:', OUT_DIR)
print('Writer split:', WRITER_SPLIT)
print('Effective triplets per epoch:', (TRIPLETS_PER_EPOCH // BATCH_SIZE) * BATCH_SIZE)
`),

  code(`# Cell 4 — Kaggle Secrets (secret values are never printed)
from kaggle_secrets import UserSecretsClient

_secret_client = UserSecretsClient()

def kaggle_secret(name, required=False):
    try:
        value = _secret_client.get_secret(name)
    except Exception:
        value = None
    if required and not value:
        raise RuntimeError(f'Missing Kaggle secret: {name}')
    return value

HF_TOKEN = kaggle_secret('HF_TOKEN')                         # optional: dataset is public
COMET_API_KEY = kaggle_secret('COMET_API_KEY')
COMET_WORKSPACE = kaggle_secret('COMET_WORKSPACE')
AWS_ACCESS_KEY_ID = kaggle_secret('AWS_ACCESS_KEY_ID')
AWS_SECRET_ACCESS_KEY = kaggle_secret('AWS_SECRET_ACCESS_KEY')
AWS_SESSION_TOKEN = kaggle_secret('AWS_SESSION_TOKEN')
AWS_REGION = kaggle_secret('AWS_REGION') or kaggle_secret('AWS_DEFAULT_REGION') or 'ap-southeast-2'
AWS_S3_BUCKET = kaggle_secret('AWS_S3_BUCKET')

COMET_ENABLED = bool(USE_COMET and COMET_API_KEY)
S3_ENABLED = bool(UPLOAD_TO_S3 and AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY and AWS_S3_BUCKET)

print({
    'HF token configured': bool(HF_TOKEN),
    'Comet enabled': COMET_ENABLED,
    'S3 enabled': S3_ENABLED,
    'AWS region': AWS_REGION,
})
if USE_COMET and not COMET_ENABLED:
    print('Comet will be skipped: add COMET_API_KEY in Kaggle Add-ons -> Secrets.')
if UPLOAD_TO_S3 and not S3_ENABLED:
    print('S3 upload will be skipped: add AWS credentials, AWS_REGION and AWS_S3_BUCKET as Kaggle secrets.')
`),

  md(`## Dataset and writer-disjoint splits

The entire identity/writer is assigned to exactly one split. This prevents the same writer from appearing in both
training and evaluation, which would inflate verification performance.
`),

  code(`# Cell 5 — download and validate CEDAR from Hugging Face
from datasets import load_dataset

dataset = load_dataset(
    HF_SIGNATURE_DATASET,
    split='train',
    revision=HF_REVISION,
    token=HF_TOKEN,
)

required_columns = {'image', 'label', 'individual', 'figure'}
missing_columns = required_columns - set(dataset.column_names)
assert not missing_columns, f'Dataset schema changed; missing columns: {sorted(missing_columns)}'

label_names = list(dataset.features['label'].names)
assert 'original' in label_names and 'forgeries' in label_names, label_names
genuine_id = label_names.index('original')

RECORDS = []
for row in tqdm(dataset, desc='Decoding CEDAR images'):
    RECORDS.append({
        'image': row['image'].convert('RGB').copy(),
        'writer': int(row['individual']),
        'figure': int(row['figure']),
        'genuine': int(row['label']) == genuine_id,
    })

writers = sorted({record['writer'] for record in RECORDS})
print('Rows:', len(RECORDS))
print('Writers:', len(writers))
print('Genuine:', sum(record['genuine'] for record in RECORDS))
print('Skilled forgeries:', sum(not record['genuine'] for record in RECORDS))
print('Dataset fingerprint:', dataset._fingerprint)

assert len(RECORDS) == 2640, 'CEDAR row count changed; inspect the dataset before continuing.'
assert len(writers) >= sum(WRITER_SPLIT), f'Only {len(writers)} writers are available.'
`),

  code(`# Cell 6 — deterministic train/validation/test writer split and leakage gate
split_rng = random.Random(SEED)
split_rng.shuffle(writers)
n_train, n_val, n_test = WRITER_SPLIT

SPLIT_WRITERS = {
    'train': writers[:n_train],
    'val': writers[n_train:n_train + n_val],
    'test': writers[n_train + n_val:n_train + n_val + n_test],
}

assert set(SPLIT_WRITERS['train']).isdisjoint(SPLIT_WRITERS['val'])
assert set(SPLIT_WRITERS['train']).isdisjoint(SPLIT_WRITERS['test'])
assert set(SPLIT_WRITERS['val']).isdisjoint(SPLIT_WRITERS['test'])

by_writer = defaultdict(lambda: {'genuine': [], 'forged': []})
for index, record in enumerate(RECORDS):
    key = 'genuine' if record['genuine'] else 'forged'
    by_writer[record['writer']][key].append(index)

for writer in writers:
    assert len(by_writer[writer]['genuine']) >= 2, f'Writer {writer} has too few genuine samples.'
    assert len(by_writer[writer]['forged']) >= 1, f'Writer {writer} has no skilled forgery samples.'

split_report = {
    split: {
        'writers': writer_ids,
        'writer_count': len(writer_ids),
        'images': sum(len(by_writer[w]['genuine']) + len(by_writer[w]['forged']) for w in writer_ids),
    }
    for split, writer_ids in SPLIT_WRITERS.items()
}
(OUT_DIR / 'writer_split.json').write_text(json.dumps(split_report, indent=2), encoding='utf-8')
print(json.dumps(split_report, indent=2))
print('WRITER LEAKAGE GATE: PASS')
`),

  md(`## Preprocessing

This matches \`SignatureEmbedder._preprocess\` in the FastAPI worker: grayscale, autocontrast, aspect-ratio-preserving
white padding, 224×224 resize, and ImageNet normalization.
`),

  code(`# Cell 7 — API-compatible preprocessing and a visual sanity check
MEAN = torch.tensor((0.485, 0.456, 0.406)).view(3, 1, 1)
STD = torch.tensor((0.229, 0.224, 0.225)).view(3, 1, 1)

def to_canvas(image: Image.Image) -> Image.Image:
    gray = ImageOps.autocontrast(image.convert('L'))
    side = max(gray.size)
    canvas = Image.new('L', (side, side), 255)
    canvas.paste(gray, ((side - gray.width) // 2, (side - gray.height) // 2))
    return canvas.resize((IMG_SIZE, IMG_SIZE), Image.Resampling.BILINEAR)

def to_tensor(canvas: Image.Image) -> torch.Tensor:
    array = np.asarray(canvas.convert('RGB'), dtype=np.uint8).copy()
    tensor = torch.from_numpy(array).permute(2, 0, 1).float().div(255.0)
    return (tensor - MEAN) / STD

CANVAS = [to_canvas(record['image']) for record in tqdm(RECORDS, desc='Preprocessing')]
GRAY = [np.asarray(canvas, dtype=np.uint8) for canvas in CANVAS]

sample_writer = SPLIT_WRITERS['train'][0]
sample_indices = by_writer[sample_writer]['genuine'][:3] + by_writer[sample_writer]['forged'][:3]
fig, axes = plt.subplots(2, 3, figsize=(10, 6))
for axis, index in zip(axes.ravel(), sample_indices):
    axis.imshow(CANVAS[index], cmap='gray')
    axis.set_title('Genuine' if RECORDS[index]['genuine'] else 'Skilled forgery')
    axis.axis('off')
plt.suptitle(f'Writer {sample_writer}: preprocessing check')
plt.tight_layout()
plt.savefig(OUT_DIR / 'preprocessing_samples.png', dpi=150, bbox_inches='tight')
plt.show()
`),

  md(`## Fixed evaluation pairs and metrics

Each validation/test writer contributes the same number of genuine, skilled-forgery and random-forgery pairs.
The threshold is selected at the validation EER point and is never re-tuned on test.
`),

  code(`# Cell 8 — fixed validation/test pairs, AUC/EER/FAR/FRR metrics
def make_pairs(split, per_writer=PAIRS_PER_WRITER, seed=SEED):
    pair_rng = random.Random(f'{seed}-{split}')
    split_writers = SPLIT_WRITERS[split]
    pairs = []  # (left_index, right_index, label, kind); label 1=match, 0=non-match
    for writer in split_writers:
        genuine = by_writer[writer]['genuine']
        forged = by_writer[writer]['forged']
        for _ in range(per_writer):
            left, right = pair_rng.sample(genuine, 2)
            pairs.append((left, right, 1, 'genuine'))
        for _ in range(per_writer):
            pairs.append((pair_rng.choice(genuine), pair_rng.choice(forged), 0, 'skilled'))
        other_writers = [candidate for candidate in split_writers if candidate != writer]
        for _ in range(per_writer):
            other = pair_rng.choice(other_writers)
            pairs.append((pair_rng.choice(genuine), pair_rng.choice(by_writer[other]['genuine']), 0, 'random'))
    return pairs

PAIRS = {split: make_pairs(split) for split in ('val', 'test')}
print('Evaluation pair counts:', {split: len(pairs) for split, pairs in PAIRS.items()})

def verification_metrics(scores, labels, threshold=None):
    scores = np.asarray(scores, dtype=float)
    labels = np.asarray(labels, dtype=int)
    fpr, tpr, thresholds = roc_curve(labels, scores)
    fnr = 1.0 - tpr
    index = int(np.nanargmin(np.abs(fnr - fpr)))
    eer = float((fpr[index] + fnr[index]) / 2.0)
    eer_threshold = float(thresholds[index])
    threshold_used = eer_threshold if threshold is None else float(threshold)
    predictions = scores >= threshold_used
    negatives = labels == 0
    positives = labels == 1
    far = float((predictions & negatives).sum() / max(1, negatives.sum()))
    frr = float(((~predictions) & positives).sum() / max(1, positives.sum()))
    return {
        'auc': float(roc_auc_score(labels, scores)),
        'eer': eer,
        'eer_threshold': eer_threshold,
        'threshold_used': threshold_used,
        'far': far,
        'frr': frr,
        'accuracy': float((predictions == labels).mean()),
        'pairs': int(len(labels)),
    }

def evaluate(score_function, split, threshold=None):
    pairs = PAIRS[split]
    scores = np.asarray([score_function(left, right) for left, right, _, _ in pairs], dtype=float)
    labels = np.asarray([label for _, _, label, _ in pairs], dtype=int)
    kinds = np.asarray([kind for _, _, _, kind in pairs])
    result = {'all': verification_metrics(scores, labels, threshold)}
    for kind in ('skilled', 'random'):
        mask = (kinds == 'genuine') | (kinds == kind)
        result[kind] = verification_metrics(scores[mask], labels[mask], result['all']['threshold_used'])
    return result, scores, labels, kinds
`),

  code(`# Cell 9 — baseline 1: SSIM
def ssim_score(left, right):
    return float(structural_similarity(GRAY[left], GRAY[right], data_range=255))

ssim_val, _, _, _ = evaluate(ssim_score, 'val')
ssim_test, ssim_test_scores, test_labels, test_kinds = evaluate(
    ssim_score,
    'test',
    threshold=ssim_val['all']['eer_threshold'],
)
print('SSIM validation:', json.dumps(ssim_val['all'], indent=2))
print('SSIM test:', json.dumps(ssim_test, indent=2))
`),

  code(`# Cell 10 — baseline 2: ImageNet ResNet18 cosine similarity
def make_backbone(pretrained=True):
    weights = torchvision.models.ResNet18_Weights.DEFAULT if pretrained else None
    model = torchvision.models.resnet18(weights=weights)
    model.fc = torch.nn.Identity()
    return model.to(device)

@torch.inference_mode()
def embed_indices(model, indices, batch_size=EMBED_BATCH_SIZE):
    model.eval()
    embeddings = {}
    for start in tqdm(range(0, len(indices), batch_size), desc='Embedding', leave=False):
        chunk = indices[start:start + batch_size]
        batch = torch.stack([to_tensor(CANVAS[index]) for index in chunk]).to(device, non_blocking=True)
        vectors = torch.nn.functional.normalize(model(batch), dim=1).cpu()
        embeddings.update({index: vectors[position] for position, index in enumerate(chunk)})
    return embeddings

def cosine_score(embeddings):
    return lambda left, right: float(torch.dot(embeddings[left], embeddings[right]))

VAL_INDICES = sorted({index for pair in PAIRS['val'] for index in pair[:2]})
TEST_INDICES = sorted({index for pair in PAIRS['test'] for index in pair[:2]})
EVAL_INDICES = sorted(set(VAL_INDICES) | set(TEST_INDICES))

imagenet_model = make_backbone(PRETRAINED)
imagenet_embeddings = embed_indices(imagenet_model, EVAL_INDICES)
imagenet_val, _, _, _ = evaluate(cosine_score(imagenet_embeddings), 'val')
imagenet_test, imagenet_test_scores, _, _ = evaluate(
    cosine_score(imagenet_embeddings),
    'test',
    threshold=imagenet_val['all']['eer_threshold'],
)
print('ImageNet ResNet18 validation:', json.dumps(imagenet_val['all'], indent=2))
print('ImageNet ResNet18 test:', json.dumps(imagenet_test, indent=2))

del imagenet_model
if torch.cuda.is_available():
    torch.cuda.empty_cache()
`),

  md(`## Siamese ResNet18 metric learning

Anchors and positives are two genuine signatures from one training writer. Negatives are a 50/50 mixture of that
writer's skilled forgeries and genuine signatures from another training writer. Only validation EER controls early stopping.
`),

  code(`# Cell 11 — optional Comet experiment
comet_experiment = None
if COMET_ENABLED:
    import comet_ml
    comet_experiment = comet_ml.start(
        api_key=COMET_API_KEY,
        workspace=COMET_WORKSPACE or None,
        project_name=COMET_PROJECT,
        mode='create',
        experiment_config=comet_ml.ExperimentConfig(
            name=RUN_VERSION,
            tags=['kaggle', 'similarity', 'siamese', 'resnet18', 'cedar'],
        ),
    )
    comet_experiment.log_parameters({
        'dataset': HF_SIGNATURE_DATASET,
        'dataset_fingerprint': dataset._fingerprint,
        'writer_split': str(WRITER_SPLIT),
        'epochs': EPOCHS,
        'triplets_per_epoch': TRIPLETS_PER_EPOCH,
        'batch_size': BATCH_SIZE,
        'learning_rate': LEARNING_RATE,
        'weight_decay': WEIGHT_DECAY,
        'triplet_margin': TRIPLET_MARGIN,
        'skilled_negative_fraction': SKILLED_NEGATIVE_FRACTION,
        'image_size': IMG_SIZE,
        'seed': SEED,
        'runtime': 'kaggle',
    })
    comet_experiment.log_metrics({
        'ssim_val_eer': ssim_val['all']['eer'],
        'imagenet_val_eer': imagenet_val['all']['eer'],
    })
    print('Comet experiment:', comet_experiment.url)
else:
    print('Comet disabled; local CSV/PNG/JSON reports will still be saved.')
`),

  code(`# Cell 12 — train Siamese ResNet18 with triplet loss and validation-only early stopping
augmentation = torchvision.transforms.RandomAffine(
    degrees=4,
    translate=(0.04, 0.04),
    scale=(0.92, 1.08),
    fill=255,
)

def sample_triplet(rng):
    writer = rng.choice(SPLIT_WRITERS['train'])
    anchor, positive = rng.sample(by_writer[writer]['genuine'], 2)
    if rng.random() < SKILLED_NEGATIVE_FRACTION:
        negative = rng.choice(by_writer[writer]['forged'])
        negative_kind = 'skilled'
    else:
        other_writers = [candidate for candidate in SPLIT_WRITERS['train'] if candidate != writer]
        other = rng.choice(other_writers)
        negative = rng.choice(by_writer[other]['genuine'])
        negative_kind = 'random'
    return anchor, positive, negative, negative_kind

def augmented_batch(indices):
    tensors = [to_tensor(augmentation(CANVAS[index])) for index in indices]
    return torch.stack(tensors).to(device, non_blocking=True)

siamese_model = make_backbone(PRETRAINED)
optimizer = torch.optim.AdamW(siamese_model.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS)
triplet_loss = torch.nn.TripletMarginWithDistanceLoss(
    distance_function=lambda left, right: 1.0 - torch.nn.functional.cosine_similarity(left, right),
    margin=TRIPLET_MARGIN,
)
amp_enabled = device.type == 'cuda'
scaler = torch.cuda.amp.GradScaler(enabled=amp_enabled)

best_eer = float('inf')
best_epoch = 0
bad_epochs = 0
history = []
best_path = OUT_DIR / 'siamese_resnet18_best.pt'
train_rng = random.Random(SEED)
steps_per_epoch = max(1, TRIPLETS_PER_EPOCH // BATCH_SIZE)

for epoch in range(1, EPOCHS + 1):
    siamese_model.train()
    losses = []
    skilled_count = 0
    started = time.time()
    progress = tqdm(range(steps_per_epoch), desc=f'Epoch {epoch}/{EPOCHS}', unit='batch')

    for _ in progress:
        triplets = [sample_triplet(train_rng) for _ in range(BATCH_SIZE)]
        skilled_count += sum(kind == 'skilled' for *_, kind in triplets)
        anchors = augmented_batch([triplet[0] for triplet in triplets])
        positives = augmented_batch([triplet[1] for triplet in triplets])
        negatives = augmented_batch([triplet[2] for triplet in triplets])

        optimizer.zero_grad(set_to_none=True)
        with torch.autocast(device_type='cuda', dtype=torch.float16, enabled=amp_enabled):
            anchor_embeddings = torch.nn.functional.normalize(siamese_model(anchors), dim=1)
            positive_embeddings = torch.nn.functional.normalize(siamese_model(positives), dim=1)
            negative_embeddings = torch.nn.functional.normalize(siamese_model(negatives), dim=1)
            loss = triplet_loss(anchor_embeddings, positive_embeddings, negative_embeddings)

        if not torch.isfinite(loss):
            raise RuntimeError(f'Non-finite loss at epoch {epoch}.')
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(siamese_model.parameters(), max_norm=5.0)
        scaler.step(optimizer)
        scaler.update()
        losses.append(float(loss.detach().cpu()))
        progress.set_postfix(loss=f'{losses[-1]:.4f}')

    scheduler.step()

    # Strictly validation writers only; test images are not embedded inside the training loop.
    validation_embeddings = embed_indices(siamese_model, VAL_INDICES)
    validation_result, _, _, _ = evaluate(cosine_score(validation_embeddings), 'val')
    row = {
        'epoch': epoch,
        'train_loss': float(np.mean(losses)),
        'val_eer': validation_result['all']['eer'],
        'val_auc': validation_result['all']['auc'],
        'val_eer_skilled': validation_result['skilled']['eer'],
        'val_eer_random': validation_result['random']['eer'],
        'learning_rate': float(scheduler.get_last_lr()[0]),
        'skilled_negative_fraction_actual': skilled_count / (steps_per_epoch * BATCH_SIZE),
        'seconds': round(time.time() - started, 1),
    }
    history.append(row)
    pd.DataFrame(history).to_csv(OUT_DIR / 'siamese_history.csv', index=False)
    print(row)

    if comet_experiment:
        comet_experiment.log_metrics(
            {key: value for key, value in row.items() if key != 'epoch'},
            step=epoch,
            epoch=epoch,
        )

    if row['val_eer'] < best_eer - EARLY_STOPPING_MIN_DELTA:
        best_eer = row['val_eer']
        best_epoch = epoch
        bad_epochs = 0
        torch.save({key: value.detach().cpu() for key, value in siamese_model.state_dict().items()}, best_path)
        print(f'New best checkpoint: epoch={best_epoch}, validation EER={best_eer:.4f}')
    else:
        bad_epochs += 1
        print(f'No validation improvement: {bad_epochs}/{EARLY_STOPPING_PATIENCE}')
        if bad_epochs >= EARLY_STOPPING_PATIENCE:
            print(f'Early stopping at epoch {epoch}; best epoch was {best_epoch}.')
            break

assert best_path.exists(), 'No checkpoint was written.'
print('Training complete | best epoch:', best_epoch, '| best validation EER:', round(best_eer, 4))
`),

  md(`## Threshold selection and one-time held-out test

The decision threshold comes from validation EER. The test writers are evaluated once after model selection.
`),

  code(`# Cell 13 — load best checkpoint, select validation threshold, evaluate held-out test writers
best_state = torch.load(best_path, map_location='cpu', weights_only=True)
siamese_model.load_state_dict(best_state)
siamese_model.to(device).eval()

siamese_val_embeddings = embed_indices(siamese_model, VAL_INDICES)
siamese_val, _, _, _ = evaluate(cosine_score(siamese_val_embeddings), 'val')
SIMILARITY_THRESHOLD = float(siamese_val['all']['eer_threshold'])

siamese_test_embeddings = embed_indices(siamese_model, TEST_INDICES)
siamese_test, siamese_test_scores, _, _ = evaluate(
    cosine_score(siamese_test_embeddings),
    'test',
    threshold=SIMILARITY_THRESHOLD,
)

methods = [
    ('SSIM', ssim_val, ssim_test),
    ('ResNet18 ImageNet baseline', imagenet_val, imagenet_test),
    ('Siamese ResNet18', siamese_val, siamese_test),
]
comparison_rows = []
for method, validation, test in methods:
    comparison_rows.append({
        'method': method,
        'val_eer': validation['all']['eer'],
        'validation_threshold': test['all']['threshold_used'],
        'test_auc': test['all']['auc'],
        'test_eer': test['all']['eer'],
        'test_far': test['all']['far'],
        'test_frr': test['all']['frr'],
        'test_accuracy': test['all']['accuracy'],
        'test_skilled_eer': test['skilled']['eer'],
        'test_skilled_far': test['skilled']['far'],
        'test_random_eer': test['random']['eer'],
        'test_random_far': test['random']['far'],
    })

comparison = pd.DataFrame(comparison_rows)
comparison.to_csv(OUT_DIR / 'similarity_comparison.csv', index=False)
display(comparison.round(4))
print('Recommended API threshold:', round(SIMILARITY_THRESHOLD, 6))
`),

  code(`# Cell 14 — ROC, training curves and score distributions
history_frame = pd.DataFrame(history)
fig, axes = plt.subplots(1, 3, figsize=(18, 5))

for name, scores in [
    ('SSIM', ssim_test_scores),
    ('ImageNet ResNet18', imagenet_test_scores),
    ('Siamese ResNet18', siamese_test_scores),
]:
    fpr, tpr, _ = roc_curve(test_labels, scores)
    auc = roc_auc_score(test_labels, scores)
    axes[0].plot(fpr, tpr, label=f'{name} (AUC {auc:.3f})')
axes[0].plot([0, 1], [0, 1], 'k--', linewidth=0.8)
axes[0].set(xlabel='False accept rate', ylabel='True accept rate', title='Test ROC — unseen writers')
axes[0].legend()
axes[0].grid(alpha=0.25)

axes[1].plot(history_frame.epoch, history_frame.train_loss, marker='o', label='train loss')
axes[1].plot(history_frame.epoch, history_frame.val_eer, marker='o', label='validation EER')
axes[1].plot(history_frame.epoch, history_frame.val_eer_skilled, marker='o', label='validation skilled EER')
axes[1].set(xlabel='Epoch', title='Siamese training')
axes[1].legend()
axes[1].grid(alpha=0.25)

axes[2].hist(siamese_test_scores[test_labels == 1], bins=30, alpha=0.55, density=True, label='genuine pairs')
axes[2].hist(siamese_test_scores[test_kinds == 'skilled'], bins=30, alpha=0.55, density=True, label='skilled forgeries')
axes[2].hist(siamese_test_scores[test_kinds == 'random'], bins=30, alpha=0.55, density=True, label='random forgeries')
axes[2].axvline(SIMILARITY_THRESHOLD, color='black', linestyle='--', label=f'threshold {SIMILARITY_THRESHOLD:.3f}')
axes[2].set(xlabel='Cosine similarity', title='Siamese test-score distributions')
axes[2].legend()

plt.tight_layout()
plt.savefig(OUT_DIR / 'similarity_results.png', dpi=180, bbox_inches='tight')
plt.show()
`),

  md(`## Export and optional S3 model registry

The API consumes a plain ResNet18 state dict plus the validated threshold stored in the S3 alias.
The S3 version is immutable; the \`latest\` alias is updated only after every artifact is uploaded and verified.
`),

  code(`# Cell 15 — export API-compatible weights, report and manifest
weights_file = OUT_DIR / 'siamese_resnet18.pt'
torch.save({key: value.detach().cpu() for key, value in siamese_model.state_dict().items()}, weights_file)

def sha256_file(path, chunk_size=4 * 1024 * 1024):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(chunk_size), b''):
            digest.update(block)
    return digest.hexdigest()

weights_sha256 = sha256_file(weights_file)
created_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

report = {
    'schema_version': 1,
    'version': RUN_VERSION,
    'created_at_utc': created_at,
    'runtime': 'kaggle',
    'task': 'writer-independent offline signature verification',
    'dataset': HF_SIGNATURE_DATASET,
    'dataset_revision': HF_REVISION,
    'dataset_fingerprint': dataset._fingerprint,
    'dataset_license_metadata': 'unknown — review source terms before commercial use',
    'writer_split': split_report,
    'seed': SEED,
    'best_epoch': best_epoch,
    'best_validation_eer': best_eer,
    'recommended_threshold': SIMILARITY_THRESHOLD,
    'weights_file': weights_file.name,
    'weights_sha256': weights_sha256,
    'preprocessing': 'grayscale, autocontrast, white square padding, 224x224, ImageNet normalization',
    'training': {
        'base_model': 'torchvision ResNet18 ImageNet',
        'loss': 'triplet margin with cosine distance',
        'margin': TRIPLET_MARGIN,
        'max_epochs': EPOCHS,
        'epochs_completed': len(history),
        'batch_size': BATCH_SIZE,
        'triplets_per_epoch': TRIPLETS_PER_EPOCH,
        'learning_rate': LEARNING_RATE,
        'skilled_negative_fraction': SKILLED_NEGATIVE_FRACTION,
    },
    'comparison': comparison_rows,
    'notes': [
        'Threshold selected on validation writers only.',
        'Test writers are disjoint and evaluated once after model selection.',
        'This is a research/course model, not a legal identity determination system.',
    ],
}

report_file = OUT_DIR / 'similarity_report.json'
report_file.write_text(json.dumps(report, indent=2), encoding='utf-8')

manifest = {
    'schema_version': 1,
    'version': RUN_VERSION,
    'task': 'signature_similarity',
    'weights_key': None,
    'weights_sha256': weights_sha256,
    'weights_size_bytes': weights_file.stat().st_size,
    'recommended_threshold': SIMILARITY_THRESHOLD,
    'best_epoch': best_epoch,
    'test_auc': siamese_test['all']['auc'],
    'test_eer': siamese_test['all']['eer'],
    'test_far': siamese_test['all']['far'],
    'test_frr': siamese_test['all']['frr'],
    'created_at_utc': created_at,
}
manifest_file = OUT_DIR / 'manifest.json'
manifest_file.write_text(json.dumps(manifest, indent=2), encoding='utf-8')

print(json.dumps({
    'version': RUN_VERSION,
    'best_epoch': best_epoch,
    'recommended_threshold': SIMILARITY_THRESHOLD,
    'weights_sha256': weights_sha256,
    'weights_mb': round(weights_file.stat().st_size / 1e6, 2),
}, indent=2))
`),

  code(`# Cell 16 — upload immutable version to S3, verify it, then update the latest alias
S3_WEIGHTS_URI = None
if S3_ENABLED:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError

    client_kwargs = {
        'aws_access_key_id': AWS_ACCESS_KEY_ID,
        'aws_secret_access_key': AWS_SECRET_ACCESS_KEY,
        'region_name': AWS_REGION,
        'config': Config(retries={'mode': 'standard', 'max_attempts': 5}),
    }
    if AWS_SESSION_TOKEN:
        client_kwargs['aws_session_token'] = AWS_SESSION_TOKEN
    s3 = boto3.client('s3', **client_kwargs)

    version_prefix = f"{S3_PREFIX.strip('/')}/versions/{RUN_VERSION}"
    weights_key = f'{version_prefix}/siamese_resnet18.pt'

    try:
        s3.head_object(Bucket=AWS_S3_BUCKET, Key=weights_key)
    except ClientError as error:
        code = error.response.get('Error', {}).get('Code')
        if code not in {'404', 'NoSuchKey', 'NotFound', '403', 'AccessDenied'}:
            raise
    else:
        raise FileExistsError(f'Immutable S3 version already exists: {RUN_VERSION}')

    upload_files = [
        weights_file,
        report_file,
        manifest_file,
        OUT_DIR / 'similarity_comparison.csv',
        OUT_DIR / 'siamese_history.csv',
        OUT_DIR / 'similarity_results.png',
        OUT_DIR / 'writer_split.json',
        OUT_DIR / 'preprocessing_samples.png',
    ]

    # Upload weights first with checksum metadata.
    s3.upload_file(
        str(weights_file),
        AWS_S3_BUCKET,
        weights_key,
        ExtraArgs={
            'ServerSideEncryption': 'AES256',
            'Metadata': {'sha256': weights_sha256, 'model-version': RUN_VERSION},
        },
    )
    head = s3.head_object(Bucket=AWS_S3_BUCKET, Key=weights_key)
    if head['ContentLength'] != weights_file.stat().st_size:
        raise RuntimeError('S3 weight size verification failed.')
    if head.get('Metadata', {}).get('sha256') != weights_sha256:
        raise RuntimeError('S3 SHA-256 metadata verification failed.')

    # Upload the remaining reports.
    for file_path in upload_files[1:]:
        key = f'{version_prefix}/{file_path.name}'
        content_type = 'application/json' if file_path.suffix == '.json' else 'text/csv' if file_path.suffix == '.csv' else 'image/png'
        s3.upload_file(
            str(file_path),
            AWS_S3_BUCKET,
            key,
            ExtraArgs={'ServerSideEncryption': 'AES256', 'ContentType': content_type},
        )

    manifest['weights_key'] = weights_key
    manifest['s3_uri'] = f's3://{AWS_S3_BUCKET}/{weights_key}'
    manifest_file.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    s3.put_object(
        Bucket=AWS_S3_BUCKET,
        Key=f'{version_prefix}/manifest.json',
        Body=manifest_file.read_bytes(),
        ContentType='application/json',
        ServerSideEncryption='AES256',
    )

    alias = {
        'version': RUN_VERSION,
        'weights_key': weights_key,
        'manifest_key': f'{version_prefix}/manifest.json',
        'sha256': weights_sha256,
        'recommended_threshold': SIMILARITY_THRESHOLD,
        'test_auc': siamese_test['all']['auc'],
        'test_eer': siamese_test['all']['eer'],
        'updated_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    s3.put_object(
        Bucket=AWS_S3_BUCKET,
        Key=f"{S3_PREFIX.strip('/')}/aliases/{S3_ALIAS}.json",
        Body=json.dumps(alias, indent=2).encode('utf-8'),
        ContentType='application/json',
        ServerSideEncryption='AES256',
    )
    S3_WEIGHTS_URI = f's3://{AWS_S3_BUCKET}/{weights_key}'
    print('S3 upload verified:', S3_WEIGHTS_URI)
    print('Alias updated:', f's3://{AWS_S3_BUCKET}/{S3_PREFIX}/aliases/{S3_ALIAS}.json')
else:
    print('S3 upload skipped. All artifacts remain in:', OUT_DIR)
`),

  code(`# Cell 17 — finish Comet logging and create one downloadable Kaggle bundle
if comet_experiment:
    comet_experiment.log_metrics({
        'best_epoch': best_epoch,
        'recommended_threshold': SIMILARITY_THRESHOLD,
        'test_auc': siamese_test['all']['auc'],
        'test_eer': siamese_test['all']['eer'],
        'test_far': siamese_test['all']['far'],
        'test_frr': siamese_test['all']['frr'],
        'test_accuracy': siamese_test['all']['accuracy'],
        'test_skilled_eer': siamese_test['skilled']['eer'],
        'test_skilled_far': siamese_test['skilled']['far'],
        'test_random_eer': siamese_test['random']['eer'],
        'test_random_far': siamese_test['random']['far'],
        'ssim_test_eer': ssim_test['all']['eer'],
        'imagenet_test_eer': imagenet_test['all']['eer'],
    })
    comet_experiment.log_table('similarity_comparison.csv', tabular_data=comparison)
    comet_experiment.log_image(str(OUT_DIR / 'similarity_results.png'), name='similarity_results')
    comet_experiment.log_image(str(OUT_DIR / 'preprocessing_samples.png'), name='preprocessing_samples')
    comet_experiment.log_asset(str(report_file))
    comet_experiment.log_asset(str(manifest_file))
    if S3_WEIGHTS_URI:
        comet_experiment.log_other('s3_weights_uri', S3_WEIGHTS_URI)
    comet_experiment.end()
    print('Comet experiment finished.')

bundle_base = Path('/kaggle/working') / f'signature_similarity_{RUN_VERSION}'
bundle_path = shutil.make_archive(str(bundle_base), 'zip', root_dir=OUT_DIR)

print('\\nCOMPLETE')
print('Version:', RUN_VERSION)
print('Best epoch:', best_epoch)
print('Test AUC:', round(siamese_test['all']['auc'], 4))
print('Test EER:', round(siamese_test['all']['eer'], 4))
print('Recommended API threshold:', round(SIMILARITY_THRESHOLD, 6))
print('Weights:', weights_file)
print('Bundle:', bundle_path)
print('S3:', S3_WEIGHTS_URI or 'not uploaded')
print('\\nAPI configuration after S3 upload:')
print('SIMILARITY_S3_ALIAS=latest')
print('SIMILARITY_S3_PREFIX=signatureai/similarity')
`),
];

const notebook = {
  cells,
  metadata: {
    kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
    language_info: { name: "python", version: "3.11" },
    kaggle: { accelerator: "gpu", dataSources: [], dockerImageVersionId: null, isGpuEnabled: true, isInternetEnabled: true },
  },
  nbformat: 4,
  nbformat_minor: 5,
};

const output = path.resolve("notebooks/02_similarity_siamese_kaggle.ipynb");
fs.writeFileSync(output, JSON.stringify(notebook, null, 1) + "\n", "utf8");
console.log(`Wrote ${output} with ${cells.length} cells`);
