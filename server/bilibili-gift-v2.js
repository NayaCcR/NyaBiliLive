const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function readVarint(buffer, state) {
  let value = 0n;
  let shift = 0n;
  for (let index = 0; index < 10; index += 1) {
    if (state.offset >= buffer.length) throw new Error("unexpected end of protobuf varint");
    const byte = buffer[state.offset];
    state.offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
  }
  throw new Error("protobuf varint is too long");
}

function decodeFields(buffer) {
  const fields = new Map();
  const state = { offset: 0 };
  while (state.offset < buffer.length) {
    const key = readVarint(buffer, state);
    const fieldNumber = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (fieldNumber <= 0) throw new Error("invalid protobuf field number");

    let value;
    if (wireType === 0) {
      value = readVarint(buffer, state);
    } else if (wireType === 1) {
      if (state.offset + 8 > buffer.length) throw new Error("unexpected end of protobuf fixed64 field");
      value = buffer.subarray(state.offset, state.offset + 8);
      state.offset += 8;
    } else if (wireType === 2) {
      const length = Number(readVarint(buffer, state));
      if (!Number.isSafeInteger(length) || length < 0 || state.offset + length > buffer.length) {
        throw new Error("invalid protobuf length-delimited field");
      }
      value = buffer.subarray(state.offset, state.offset + length);
      state.offset += length;
    } else if (wireType === 5) {
      if (state.offset + 4 > buffer.length) throw new Error("unexpected end of protobuf fixed32 field");
      value = buffer.subarray(state.offset, state.offset + 4);
      state.offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }

    const values = fields.get(fieldNumber) || [];
    values.push({ wireType, value });
    fields.set(fieldNumber, values);
  }
  return fields;
}

function firstField(fields, fieldNumber, wireType) {
  return fields.get(fieldNumber)?.find((field) => field.wireType === wireType)?.value;
}

function integer(fields, fieldNumber) {
  const value = firstField(fields, fieldNumber, 0) ?? 0n;
  return value <= MAX_SAFE_BIGINT ? Number(value) : value.toString();
}

function string(fields, fieldNumber) {
  return firstField(fields, fieldNumber, 2)?.toString("utf8") || "";
}

function message(fields, fieldNumber) {
  const value = firstField(fields, fieldNumber, 2);
  return value ? decodeFields(value) : new Map();
}

function messages(fields, fieldNumber) {
  return (fields.get(fieldNumber) || [])
    .filter((field) => field.wireType === 2)
    .map((field) => decodeFields(field.value));
}

function decodeMedalInfo(fields) {
  return {
    target_id: integer(fields, 1),
    anchor_roomid: integer(fields, 4),
    medal_level: integer(fields, 5),
    medal_name: string(fields, 6),
  };
}

function decodeBlindGift(fields) {
  return {
    original_gift_name: string(fields, 3),
    original_gift_price: integer(fields, 6),
  };
}

function decodeGiftItem(fields) {
  const giftInfo = message(fields, 35);
  return {
    gift_id: integer(fields, 1),
    gift_name: string(fields, 2),
    num: integer(fields, 3),
    gift_type: integer(fields, 4),
    price: integer(fields, 5),
    total_coin: integer(fields, 7),
    coin_type: string(fields, 8),
    tid: string(fields, 9),
    timestamp: integer(fields, 10),
    rnd: string(fields, 12),
    action: string(fields, 18),
    gift_img_basic: string(giftInfo, 1),
  };
}

/** Decode the Base64 protobuf payload carried by Bilibili's SEND_GIFT_V2 command. */
export function decodeSendGiftV2(encodedPayload) {
  if (typeof encodedPayload !== "string" || !encodedPayload.trim()) return [];
  const payload = Buffer.from(encodedPayload, "base64");
  if (!payload.length) throw new Error("empty SEND_GIFT_V2 protobuf payload");
  const fields = decodeFields(payload);
  const sender = {
    uid: integer(fields, 1),
    uname: string(fields, 2),
    face: string(fields, 3),
    guard_level: integer(fields, 5),
  };
  const medal_info = decodeMedalInfo(message(fields, 8));
  const blind_gift = decodeBlindGift(message(fields, 9));
  return messages(fields, 10).map((giftFields) => ({
    ...sender,
    medal_info,
    blind_gift,
    ...decodeGiftItem(giftFields),
  }));
}
