/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import { AbruptCompletion, PossiblyNormalCompletion } from "../completions.js";
import { InfeasiblePathError } from "../errors.js";
import type { Realm } from "../realm.js";
import { construct_empty_effects } from "../realm.js";
import type { LexicalEnvironment } from "../environment.js";
import { AbstractValue, ConcreteValue, Value } from "../values/index.js";
import { Reference } from "../environment.js";
import { UpdateEmpty } from "../methods/index.js";
import type { BabelNode, BabelNodeIfStatement } from "babel-types";
import invariant from "../invariant.js";
import { Environment, Join, Path, To } from "../singletons.js";

export function evaluate(ast: BabelNodeIfStatement, strictCode: boolean, env: LexicalEnvironment, realm: Realm): Value {
  // 1. Let exprRef be the result of evaluating Expression
  let exprRef = env.evaluate(ast.test, strictCode);
  // 2. Let exprValue be ToBoolean(? GetValue(exprRef))
  let exprValue: Value = Environment.GetConditionValue(realm, exprRef);

  if (exprValue instanceof ConcreteValue) {
    let stmtCompletion;
    if (To.ToBoolean(realm, exprValue)) {
      // 3.a. Let stmtCompletion be the result of evaluating the first Statement
      stmtCompletion = env.evaluateCompletion(ast.consequent, strictCode);
    } else {
      if (ast.alternate)
        // 4.a. Let stmtCompletion be the result of evaluating the second Statement
        stmtCompletion = env.evaluateCompletion(ast.alternate, strictCode);
      else
        // 3 (of the if only statement). Return NormalCompletion(undefined)
        stmtCompletion = realm.intrinsics.undefined;
    }
    // 5. Return Completion(UpdateEmpty(stmtCompletion, undefined)
    //if (stmtCompletion instanceof Reference) return stmtCompletion;
    invariant(!(stmtCompletion instanceof Reference));
    stmtCompletion = UpdateEmpty(realm, stmtCompletion, realm.intrinsics.undefined);
    if (stmtCompletion instanceof AbruptCompletion) {
      throw stmtCompletion;
    }
    invariant(stmtCompletion instanceof Value);
    return stmtCompletion;
  }
  invariant(exprValue instanceof AbstractValue);

  if (!exprValue.mightNotBeTrue()) {
    let stmtCompletion = env.evaluate(ast.consequent, strictCode);
    invariant(!(stmtCompletion instanceof Reference));
    stmtCompletion = UpdateEmpty(realm, stmtCompletion, realm.intrinsics.undefined);
    if (stmtCompletion instanceof AbruptCompletion) {
      throw stmtCompletion;
    }
    invariant(stmtCompletion instanceof Value);
    return stmtCompletion;
  } else if (!exprValue.mightNotBeFalse()) {
    let stmtCompletion;
    if (ast.alternate) stmtCompletion = env.evaluate(ast.alternate, strictCode);
    else stmtCompletion = realm.intrinsics.undefined;
    invariant(!(stmtCompletion instanceof Reference));
    stmtCompletion = UpdateEmpty(realm, stmtCompletion, realm.intrinsics.undefined);
    if (stmtCompletion instanceof AbruptCompletion) {
      throw stmtCompletion;
    }
    invariant(stmtCompletion instanceof Value);
    return stmtCompletion;
  } else {
    invariant(exprValue instanceof AbstractValue);
    return evaluateWithAbstractConditional(exprValue, ast.consequent, ast.alternate, strictCode, env, realm);
  }
}

export function evaluateWithAbstractConditional(
  condValue: AbstractValue,
  consequent: BabelNode,
  alternate: ?BabelNode,
  strictCode: boolean,
  env: LexicalEnvironment,
  realm: Realm
): Value {
  // Evaluate consequent and alternate in sandboxes and get their effects.
  let compl1, gen1, bindings1, properties1, createdObj1;
  try {
    [compl1, gen1, bindings1, properties1, createdObj1] = Path.withCondition(condValue, () => {
      return realm.evaluateNodeForEffects(consequent, strictCode, env);
    });
  } catch (e) {
    if (e instanceof InfeasiblePathError) {
      let stmtCompletion;
      if (alternate)
        // 4.a. Let stmtCompletion be the result of evaluating the second Statement
        stmtCompletion = env.evaluateCompletion(alternate, strictCode);
      else
        // 3 (of the if only statement). Return NormalCompletion(undefined)
        stmtCompletion = realm.intrinsics.undefined;
      invariant(!(stmtCompletion instanceof Reference));
      stmtCompletion = UpdateEmpty(realm, stmtCompletion, realm.intrinsics.undefined);
      if (stmtCompletion instanceof AbruptCompletion) {
        throw stmtCompletion;
      }
      invariant(stmtCompletion instanceof Value);
      return stmtCompletion;
    }
    throw e;
  }

  let compl2, gen2, bindings2, properties2, createdObj2;
  try {
    [compl2, gen2, bindings2, properties2, createdObj2] = Path.withInverseCondition(condValue, () => {
      return alternate ? realm.evaluateNodeForEffects(alternate, strictCode, env) : construct_empty_effects(realm);
    });
  } catch (e) {
    if (e instanceof InfeasiblePathError) {
      let stmtCompletion = env.evaluate(consequent, strictCode);
      invariant(!(stmtCompletion instanceof Reference));
      stmtCompletion = UpdateEmpty(realm, stmtCompletion, realm.intrinsics.undefined);
      if (stmtCompletion instanceof AbruptCompletion) {
        throw stmtCompletion;
      }
      invariant(stmtCompletion instanceof Value);
      return stmtCompletion;
    }
    throw e;
  }

  // Join the effects, creating an abstract view of what happened, regardless
  // of the actual value of condValue.
  let joinedEffects = Join.joinEffects(
    realm,
    condValue,
    [compl1, gen1, bindings1, properties1, createdObj1],
    [compl2, gen2, bindings2, properties2, createdObj2]
  );
  let completion = joinedEffects[0];
  if (completion instanceof PossiblyNormalCompletion) {
    // in this case one of the branches may complete abruptly, which means that
    // not all control flow branches join into one flow at this point.
    // Consequently we have to continue tracking changes until the point where
    // all the branches come together into one.
    completion = realm.composeWithSavedCompletion(completion);
  }
  // Note that the effects of (non joining) abrupt branches are not included
  // in joinedEffects, but are tracked separately inside completion.
  realm.applyEffects(joinedEffects);

  // return or throw completion
  if (completion instanceof AbruptCompletion) throw completion;
  invariant(completion instanceof Value);
  return completion;
}
