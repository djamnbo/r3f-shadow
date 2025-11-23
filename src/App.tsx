import { useRef, useState, useEffect, useMemo, Suspense } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  OrthographicCamera,
  OrbitControls,
  KeyboardControls,
  KeyboardControlsEntry,
  useKeyboardControls,
  useGLTF,
  useAnimations,
  Html,
  Box
} from '@react-three/drei';
import {
  Physics,
  RigidBody,
  RapierRigidBody,
  CapsuleCollider,
  BallCollider,
  useRapier,
  MeshCollider,
  CuboidCollider
} from '@react-three/rapier';
import {
  Group,
  Vector3,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshBasicMaterial,
  GreaterDepth,
  MathUtils,
  Color,
  DoubleSide,
  Vector3 as ThreeVector3,
  BufferGeometry,
  Quaternion,
  Euler,
} from 'three';
import { SkeletonUtils } from 'three-stdlib';
import { useControls } from 'leva';
import { create } from 'zustand';

// V182: 플레이어 모델 자가 투과(Self-Transparency) 현상 수정
// PlayerVisuals에서 material.transparent = false 강제 적용

// 🟢 전역 상태 관리 (Zustand)
interface GameState {
  isAlerted: boolean;
  setAlerted: (alerted: boolean) => void;
  playerPosition: ThreeVector3;
  setPlayerPosition: (pos: ThreeVector3) => void;
  isCrouching: boolean;
  setIsCrouching: (crouching: boolean) => void;
  isJumping: boolean;
  setIsJumping: (jumping: boolean) => void;
  isInCover: boolean;
  setInCover: (inCover: boolean) => void;
}

const useGameStore = create<GameState>((set) => ({
  isAlerted: false,
  setAlerted: (alerted) => set({ isAlerted: alerted }),
  playerPosition: new ThreeVector3(0, 0, 0),
  setPlayerPosition: (pos) => set({ playerPosition: pos }),
  isCrouching: false,
  setIsCrouching: (crouching) => set({ isCrouching: crouching }),
  isJumping: false,
  setIsJumping: (jumping) => set({ isJumping: jumping }),
  isInCover: false,
  setInCover: (inCover) => set({ isInCover: inCover }),
}));

enum Controls {
  forward = 'forward',
  backward = 'backward',
  left = 'left',
  right = 'right',
  jump = 'jump',
  toggleMode = 'toggleMode',
  interact = 'interact',
  inventory = 'inventory',
  special = 'special',
  switchChar = 'switchChar',
  menu = 'menu',
}

const keyboardMap: KeyboardControlsEntry<Controls>[] = [
  { name: Controls.forward, keys: ['ArrowUp', 'KeyW'] },
  { name: Controls.backward, keys: ['ArrowDown', 'KeyS'] },
  { name: Controls.left, keys: ['ArrowLeft', 'KeyA'] },
  { name: Controls.right, keys: ['ArrowRight', 'KeyD'] },
  { name: Controls.jump, keys: ['KeyS'] },
  { name: Controls.toggleMode, keys: ['KeyQ'] },
  { name: Controls.interact, keys: ['KeyA'] },
  { name: Controls.inventory, keys: ['KeyW'] },
  { name: Controls.special, keys: ['KeyD'] },
  { name: Controls.switchChar, keys: ['KeyE'] },
  { name: Controls.menu, keys: ['Escape'] },
];

const START_POSITION: [number, number, number] = [-38.5, 1.2, 11];
const BASE_ZOOM = 84;
const BASE_DISTANCE = 40;

const RUN_SPEED = 4.6;
const WALK_SPEED = 2;
const JUMP_FORCE = 7.2;
const DASH_JUMP_FORCE = 4.8;
const DASH_SPEED = 6.2;
const AIR_SPEED = 2;
const JUMP_ANIM_START_TIME = 0.6;

const VIEW_DISTANCE = 10;
const RED_ZONE_DIST = 7;
const HEIGHT_THRESHOLD = 3;
const FOV = 60;
const VERTICAL_FOV = 30;

// 🧱 충돌 그룹 설정 (Bitmask)
const GROUP_LEVEL = 196607;
const GROUP_RAY_VISION = 65538;

// 🌿 수풀(Bush) 컴포넌트
const Bush = ({ position }: { position: [number, number, number] }) => {
  const { setInCover } = useGameStore();

  return (
    <group position={position}>
      <Box args={[2, 1.5, 2]} position={[0, 0.75, 0]}>
        <meshStandardMaterial color="#2e8b57" transparent opacity={0.6} />
      </Box>
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider
          args={[1, 0.75, 1]}
          position={[0, 0.75, 0]}
          sensor
          onIntersectionEnter={() => setInCover(true)}
          onIntersectionExit={() => setInCover(false)}
        />
      </RigidBody>
    </group>
  );
};

// 동적 시야각 컴포넌트
const DynamicVisionCone = ({
                             parentBody,
                             rayCount = 60,
                             fov = FOV,
                             viewDistance = VIEW_DISTANCE
                           }: {
  parentBody: React.RefObject<RapierRigidBody | null>,
  rayCount?: number,
  fov?: number,
  viewDistance?: number
}) => {
  const { world, rapier } = useRapier();

  const meshRedRef = useRef<Mesh>(null);
  const geoRedRef = useRef<BufferGeometry>(null);

  const meshYellowRef = useRef<Mesh>(null);
  const geoYellowRef = useRef<BufferGeometry>(null);

  const vertexCount = rayCount + 2;

  const positionsRed = useMemo(() => new Float32Array(vertexCount * 3).fill(0), [vertexCount]);
  const positionsYellow = useMemo(() => new Float32Array(vertexCount * 3).fill(0), [vertexCount]);

  const indices = useMemo(() => {
    const idx = [];
    for (let i = 1; i <= rayCount; i++) idx.push(0, i, i + 1);
    return new Uint16Array(idx);
  }, [rayCount]);

  useFrame(() => {
    if (!meshRedRef.current || !world || !rapier || !parentBody.current) return;

    meshRedRef.current.updateMatrixWorld();
    if(meshYellowRef.current) meshYellowRef.current.updateMatrixWorld();

    const worldPos = new ThreeVector3();
    const worldDir = new ThreeVector3();
    meshRedRef.current.getWorldPosition(worldPos);
    meshRedRef.current.getWorldDirection(worldDir);

    if (isNaN(worldDir.x) || isNaN(worldDir.z)) return;

    const halfFov = MathUtils.degToRad(fov / 2);
    const angleStep = MathUtils.degToRad(fov) / rayCount;

    geoRedRef.current?.attributes.position.setXYZ(0, 0, 0, 0);
    geoYellowRef.current?.attributes.position.setXYZ(0, 0, 0, 0);

    const excludeBody = parentBody.current;

    for (let i = 0; i <= rayCount; i++) {
      const localAngle = -halfFov + (angleStep * i);
      const meshRotationY = Math.atan2(worldDir.x, worldDir.z);
      const worldRayAngle = meshRotationY + localAngle;

      const dx = Math.sin(worldRayAngle);
      const dz = Math.cos(worldRayAngle);

      const rayOrigin = { x: worldPos.x, y: worldPos.y + 1.7, z: worldPos.z };
      const rayDirection = { x: dx, y: 0, z: dz };
      const ray = new rapier.Ray(rayOrigin, rayDirection);

      const hit = world.castRay(
        ray,
        viewDistance,
        true,
        undefined,
        GROUP_RAY_VISION,
        undefined,
        excludeBody
      );

      let dist = viewDistance;
      if (hit) {
        const hitAny = hit as any;
        const hitDist = hitAny.toi ?? hitAny.timeOfImpact;
        if (typeof hitDist === 'number') dist = hitDist;
        if (dist < 0.01) dist = viewDistance;
      }
      if (isNaN(dist)) dist = viewDistance;

      const distRed = Math.min(dist, RED_ZONE_DIST);
      const distYellow = dist;

      let lxRed = Math.sin(localAngle) * distRed;
      let lzRed = Math.cos(localAngle) * distRed;
      geoRedRef.current?.attributes.position.setXYZ(i + 1, lxRed, 0, lzRed);

      let lxYellow = Math.sin(localAngle) * distYellow;
      let lzYellow = Math.cos(localAngle) * distYellow;
      geoYellowRef.current?.attributes.position.setXYZ(i + 1, lxYellow, 0, lzYellow);
    }

    if(geoRedRef.current) {
      geoRedRef.current.attributes.position.needsUpdate = true;
      geoRedRef.current.computeBoundingSphere();
    }
    if(geoYellowRef.current) {
      geoYellowRef.current.attributes.position.needsUpdate = true;
      geoYellowRef.current.computeBoundingSphere();
    }
  });

  return (
    <group position={[0, 0.05, 0]}>
      <mesh ref={meshYellowRef} position={[0, -0.01, 0]} frustumCulled={false}>
        <bufferGeometry ref={geoYellowRef}>
          <bufferAttribute attach="attributes-position" count={vertexCount} array={positionsYellow} itemSize={3} />
          <bufferAttribute attach="index" count={indices.length} array={indices} itemSize={1} />
        </bufferGeometry>
        <meshBasicMaterial color="#ffff00" transparent opacity={0.2} side={DoubleSide} depthWrite={false} />
      </mesh>
      <mesh ref={meshRedRef} position={[0, 0, 0]} frustumCulled={false}>
        <bufferGeometry ref={geoRedRef}>
          <bufferAttribute attach="attributes-position" count={vertexCount} array={positionsRed} itemSize={3} />
          <bufferAttribute attach="index" count={indices.length} array={indices} itemSize={1} />
        </bufferGeometry>
        <meshBasicMaterial color="#ff0000" transparent opacity={0.4} side={DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
};

const Enemy = ({ path }: { path: Vector3[] }) => {
  const rigidBody = useRef<RapierRigidBody>(null);
  const groupRef = useRef<Group>(null);
  const { scene, animations } = useGLTF('/models/hero.glb');
  const clone = useMemo(() => SkeletonUtils.clone(scene), [scene]);
  const { actions } = useAnimations(animations, groupRef);

  const [currentPointIndex, setCurrentPointIndex] = useState(0);
  const [isWaiting, setIsWaiting] = useState(false);
  const [detected, setDetected] = useState(false);

  const { isAlerted, setAlerted, playerPosition, isCrouching, isJumping, isInCover } = useGameStore();
  const { world, rapier } = useRapier();

  useEffect(() => {
    clone.traverse((child: any) => {
      if (child.isMesh) {
        child.material = child.material.clone();
        child.material.color = detected || isAlerted ? new Color('#ff0000') : new Color('#556644');
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }, [clone, detected, isAlerted]);

  useFrame((state, delta) => {
    if (!rigidBody.current || !groupRef.current) return;

    const currentPos = rigidBody.current.translation();
    const currentVec3 = new ThreeVector3(currentPos.x, currentPos.y, currentPos.z);

    // --- 🤖 플레이어 감지 로직 ---
    if (!isAlerted) {
      const isFullStealth = isInCover && isCrouching;

      if (!isFullStealth) {
        const distToPlayer = currentVec3.distanceTo(playerPosition);

        if (distToPlayer < VIEW_DISTANCE) {
          const heightDiff = Math.abs(playerPosition.y - currentPos.y);
          const isHeightDiffLarge = heightDiff > HEIGHT_THRESHOLD;
          const isRedZone = (distToPlayer <= RED_ZONE_DIST) && !isHeightDiffLarge;

          let shouldDetect = false;
          if (isRedZone) shouldDetect = true;
          else if (!isCrouching || isJumping) shouldDetect = true;

          if (shouldDetect) {
            const dirToPlayer = new ThreeVector3().subVectors(playerPosition, currentVec3).normalize();
            const enemyForward = new ThreeVector3(0, 0, 1).applyQuaternion(groupRef.current.quaternion).normalize();
            const dirToPlayerFlat = new ThreeVector3(dirToPlayer.x, 0, dirToPlayer.z).normalize();
            const enemyForwardFlat = new ThreeVector3(enemyForward.x, 0, enemyForward.z).normalize();
            const angleFlat = enemyForwardFlat.angleTo(dirToPlayerFlat);
            const verticalAngle = MathUtils.radToDeg(Math.atan2(heightDiff, distToPlayer));

            if (MathUtils.radToDeg(angleFlat) < FOV / 2 && verticalAngle < VERTICAL_FOV) {

              const targetHeightOffset = isCrouching ? 0.9 : 1.7;
              const rayStartPos = { x: currentPos.x, y: currentPos.y + 1.7, z: currentPos.z };
              const playerTargetPos = new ThreeVector3(playerPosition.x, playerPosition.y + targetHeightOffset, playerPosition.z);

              const rayDir = new ThreeVector3().subVectors(playerTargetPos, new ThreeVector3(rayStartPos.x, rayStartPos.y, rayStartPos.z)).normalize();
              const ray = new rapier.Ray(rayStartPos, rayDir);
              const exactDistToTarget = new ThreeVector3(rayStartPos.x, rayStartPos.y, rayStartPos.z).distanceTo(playerTargetPos);

              // 🚀 [핵심] filterFlags: 2 (EXCLUDE_DYNAMIC)
              const hit = world.castRay(
                ray,
                exactDistToTarget,
                true,
                2,          // 🌟 flags: 2 (EXCLUDE_DYNAMIC)
                undefined,
                undefined,
                rigidBody.current
              );

              let blocked = false;
              if (hit) {
                const hitDist = (hit as any).toi ?? (hit as any).timeOfImpact;
                // 벽이 플레이어보다 가까이 있으면 차단됨
                if (hitDist < exactDistToTarget - 0.2) {
                  blocked = true;
                }
              }

              if (!blocked) {
                console.log(`🚨 Player Detected! Zone: ${isRedZone ? 'RED' : 'YELLOW'}`);
                setAlerted(true);
                setDetected(true);
              }
            }
          }
        }
      }
    }

    // --- 이동 로직 ---
    let targetPos = new ThreeVector3();
    let moveSpeed = 2;

    if (isAlerted) {
      targetPos.copy(playerPosition);
      moveSpeed = 4.5;
      const runAction = actions['Run'];
      const walkAction = actions['Walk'];
      if (runAction && !runAction.isRunning()) {
        walkAction?.fadeOut(0.2);
        runAction.reset().fadeIn(0.2).play();
      }
    } else {
      if (path.length === 0) return;
      targetPos.copy(path[currentPointIndex]);
      moveSpeed = 2;

      if (currentPos.y < -10) {
        rigidBody.current.setTranslation(path[0], true);
        rigidBody.current.setLinvel({x:0, y:0, z:0}, true);
        return;
      }

      const distToTarget = new ThreeVector3(currentPos.x, 0, currentPos.z).distanceTo(new ThreeVector3(targetPos.x, 0, targetPos.z));

      if (distToTarget < 0.5) {
        if (!isWaiting) {
          setIsWaiting(true);
          actions['Walk']?.fadeOut(0.2);
          actions['Idle']?.reset().fadeIn(0.2).play();
          setTimeout(() => {
            setCurrentPointIndex((prev) => (prev + 1) % path.length);
            setIsWaiting(false);
            actions['Idle']?.fadeOut(0.2);
            actions['Walk']?.reset().fadeIn(0.2).play();
          }, 2000);
        }
        rigidBody.current.setLinvel({ x: 0, y: 0, z: 0 }, true);
        return;
      }
      if (!isWaiting) {
        const walkAction = actions['Walk'];
        if (walkAction && !walkAction.isRunning()) walkAction.reset().play();
      }
    }

    const direction = new ThreeVector3().subVectors(targetPos, currentVec3);
    direction.y = 0;
    direction.normalize();

    rigidBody.current.setLinvel({
      x: direction.x * moveSpeed,
      y: rigidBody.current.linvel().y,
      z: direction.z * moveSpeed
    }, true);

    if (direction.lengthSq() > 0.001) {
      const targetRotation = Math.atan2(direction.x, direction.z);
      const targetQuat = new Quaternion();
      targetQuat.setFromEuler(new Euler(0, targetRotation, 0));
      groupRef.current.quaternion.slerp(targetQuat, 0.1);
    }
  });

  return (
    <RigidBody
      ref={rigidBody}
      position={path[0]}
      enabledRotations={[false, false, false]}
      colliders={false}
      friction={0}
      gravityScale={3}
    >
      <CapsuleCollider args={[0.75, 0.3]} position={[0, 1, 0]} />
      <group ref={groupRef}>
        <primitive object={clone} scale={0.8} position={[0, 0, 0]} />
        <DynamicVisionCone parentBody={rigidBody} fov={FOV} viewDistance={VIEW_DISTANCE} />
      </group>
    </RigidBody>
  );
};

const PlayerVisuals = ({ scene, animations, currentAnimation, isGhost = false }: any) => {
  const groupRef = useRef<Group>(null);
  const { actions } = useAnimations(animations, groupRef);

  useEffect(() => {
    const action = actions[currentAnimation];
    if (action) {
      action.reset();
      if (currentAnimation === "Jump" || currentAnimation === "Dash") {
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
        if (currentAnimation === "Jump") action.time = JUMP_ANIM_START_TIME;
      } else {
        action.setLoop(LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      }
      action.fadeIn(0.2).play();
      return () => { action.fadeOut(0.2); };
    }
  }, [currentAnimation, actions]);

  useEffect(() => {
    if (isGhost) {
      scene.traverse((child: any) => {
        if (child.isMesh) {
          child.material = new MeshBasicMaterial({
            color: 0xff4444, transparent: true, opacity: 0.3, depthFunc: GreaterDepth, depthWrite: false,
          });
          child.castShadow = false; child.receiveShadow = false;
        }
      });
    } else {
      scene.traverse((child: any) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;

          // 🚀 [수정] 자가 투과 방지 (Self-Transparency Issue Fix)
          // 모델 재질을 강제로 불투명하게 설정하고 깊이 버퍼에 기록하게 합니다.
          if (child.material) {
            child.material.transparent = false; // 투명도 끔
            child.material.opacity = 1.0;       // 완전 불투명
            child.material.depthWrite = true;   // 깊이 기록 (앞뒤 구분)
            child.material.depthTest = true;    // 깊이 테스트
            child.material.needsUpdate = true;  // 변경사항 적용
          }
        }
      });
    }
  }, [scene, isGhost]);

  return <group ref={groupRef}><primitive object={scene} /></group>;
};

const Player = ({ isLive, orbitControlsRef }: any) => {
  const rigidBody = useRef<RapierRigidBody>(null);
  const rotationGroup = useRef<Group>(null);
  const posDebugRef = useRef<HTMLDivElement>(null);
  const [sub, get] = useKeyboardControls<Controls>();
  const { world, rapier } = useRapier();
  const isLiveRef = useRef(isLive);

  const { setPlayerPosition, setIsCrouching, isCrouching, setIsJumping } = useGameStore();

  useEffect(() => { isLiveRef.current = isLive; }, [isLive]);
  const { scene, animations } = useGLTF('/models/hero.glb');
  const ghostScene = useMemo(() => SkeletonUtils.clone(scene), [scene]);
  const [animation, setAnimation] = useState("Idle");

  const [localCrouch, setLocalCrouch] = useState(false);
  useEffect(() => { setIsCrouching(localCrouch); }, [localCrouch, setIsCrouching]);

  const isMovingRef = useRef(false);
  const inAir = useRef(false);
  const { camera } = useThree();

  useEffect(() => {
    const unsubscribeJump = sub((state) => state.jump, (pressed) => {
      if (pressed && rigidBody.current && !inAir.current) {
        const playerPos = rigidBody.current.translation();
        const ray = new rapier.Ray({ x: playerPos.x, y: playerPos.y + 0.05, z: playerPos.z }, { x: 0, y: -1, z: 0 });
        const hit = world.castRay(ray, 0.2, true, undefined, undefined, undefined, rigidBody.current);
        if (hit) {
          const isRunning = isMovingRef.current && !localCrouch;
          const jumpVelocity = isRunning ? DASH_JUMP_FORCE : JUMP_FORCE;
          const currentVel = rigidBody.current.linvel();
          rigidBody.current.setLinvel({ x: currentVel.x, y: jumpVelocity, z: currentVel.z }, true);

          inAir.current = true;
          setIsJumping(true);

          setTimeout(() => {
            inAir.current = false;
            setIsJumping(false);
          }, 500);
        }
      }
    });
    const unsubscribeCrouch = sub((state) => state.toggleMode, (pressed) => {
      if (pressed) setLocalCrouch((prev) => !prev);
    });
    return () => { unsubscribeJump(); unsubscribeCrouch(); };
  }, [sub, world, rapier, localCrouch, setIsJumping]);

  useFrame(() => {
    if (!rigidBody.current) return;
    const currentPos = rigidBody.current.translation();
    setPlayerPosition(new ThreeVector3(currentPos.x, currentPos.y, currentPos.z));
    const { forward, backward, left, right } = get();
    const velocity = rigidBody.current.linvel();

    if (!isLiveRef.current && posDebugRef.current) {
      posDebugRef.current.innerText = `X: ${currentPos.x.toFixed(1)}\nY: ${currentPos.y.toFixed(1)}\nZ: ${currentPos.z.toFixed(1)}`;
    }
    if (currentPos.y < -10) {
      rigidBody.current.setTranslation({ x: START_POSITION[0], y: START_POSITION[1], z: START_POSITION[2] }, true);
      rigidBody.current.setLinvel({ x: 0, y: 0, z: 0 }, true);
      inAir.current = false;
    }
    const direction = new Vector3(0, 0, 0);
    if (forward) { direction.x -= 1; direction.z -= 1; }
    if (backward) { direction.x += 1; direction.z += 1; }
    if (left) { direction.x -= 1; direction.z += 1; }
    if (right) { direction.x += 1; direction.z -= 1; }
    const isMoving = direction.length() > 0;
    isMovingRef.current = isMoving;

    let isGrounded = false;
    if (!inAir.current) {
      const ray = new rapier.Ray({ x: currentPos.x, y: currentPos.y + 0.05, z: currentPos.z }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(ray, 0.2, true, undefined, undefined, undefined, rigidBody.current);
      isGrounded = hit !== null;
    }
    let nextAnimation = "Idle";
    let currentSpeed = 0;
    if (inAir.current || !isGrounded) {
      nextAnimation = (animation === "Dash" || (inAir.current && isMoving && !localCrouch)) ? "Dash" : "Jump";
      currentSpeed = (nextAnimation === "Dash") ? DASH_SPEED : AIR_SPEED;
      if(isMoving) {
        direction.normalize();
        if (rotationGroup.current) rotationGroup.current.rotation.y = Math.atan2(direction.x, direction.z);
      } else currentSpeed = 0;
    } else if (isMoving) {
      nextAnimation = localCrouch ? "Walk" : "Run";
      currentSpeed = localCrouch ? WALK_SPEED : RUN_SPEED;
      direction.normalize();
      if (rotationGroup.current) rotationGroup.current.rotation.y = Math.atan2(direction.x, direction.z);
    } else {
      nextAnimation = localCrouch ? "Crouch" : "Idle";
      currentSpeed = 0;
    }
    if (animation !== nextAnimation) setAnimation(nextAnimation);
    rigidBody.current.setLinvel({ x: direction.x * currentSpeed, y: velocity.y, z: direction.z * currentSpeed }, true);

    if (isLiveRef.current) {
      const dist = BASE_DISTANCE; const isoVec = 0.57735;
      camera.position.set(currentPos.x + dist * isoVec, currentPos.y + dist * isoVec, currentPos.z + dist * isoVec);
      camera.lookAt(currentPos.x, currentPos.y, currentPos.z);
      camera.zoom = BASE_ZOOM; camera.updateProjectionMatrix();
    } else {
      if (orbitControlsRef.current) { orbitControlsRef.current.target.set(currentPos.x, currentPos.y, currentPos.z); orbitControlsRef.current.update(); }
    }
  });

  return (
    <RigidBody ref={rigidBody} position={START_POSITION} enabledRotations={[false, false, false]} colliders={false} friction={0.0} gravityScale={2.6} ccd mass={1}>
      <BallCollider args={[0.3]} position={[0, 0.3, 0]} friction={0} />
      <CapsuleCollider args={localCrouch ? [0.025, 0.58] : [0.3, 0.4]} position={localCrouch ? [0, 0.7, 0] : [0, 0.8, 0]} />
      {!isLive && <Html position={[0, 2.5, 0]} center><div ref={posDebugRef} style={{fontFamily: 'monospace', fontSize: '12px', color: '#00ff00', background: 'rgba(0,0,0,0.7)', padding: '4px 8px', borderRadius: '4px', whiteSpace: 'pre', pointerEvents: 'none', userSelect: 'none'}}>Loading...</div></Html>}
      <group ref={rotationGroup}>
        <group scale={0.8}><PlayerVisuals scene={scene} animations={animations} currentAnimation={animation} isGhost={false} /></group>
        <group scale={0.8}><PlayerVisuals scene={ghostScene} animations={animations} currentAnimation={animation} isGhost={true} /></group>
      </group>
    </RigidBody>
  );
};

const Level = () => {
  const { scene } = useGLTF('/models/level_test.glb');

  useEffect(() => {
    scene.traverse((child: any) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.name.includes('InvisibleWall')) child.visible = false;
      }
    });
  }, [scene]);

  return (
    <group>
      {/* RigidBody에 collisionGroups 적용 (Level Group 1) */}
      <RigidBody type="fixed" colliders={false} collisionGroups={GROUP_LEVEL}>
        <MeshCollider type="trimesh">
          <primitive object={scene} />
        </MeshCollider>
      </RigidBody>

      <Bush position={[-15, 0, 15]} />
      <Bush position={[-26, 0, 10]} />

      <Enemy path={[
        new Vector3(-11, 5, 20),
        new Vector3(-8.5, 5, 15.2),
        new Vector3(-4.2, 5, 16),
        new Vector3(-6, 5, 24)
      ]} />

      <Enemy path={[
        new Vector3(-16.5, 5, 13.0),
        new Vector3(-9.4, 5, 13.1)
      ]} />
    </group>
  );
};

export default function App() {
  const { isLiveMode, showPhysics } = useControls({
    isLiveMode: { value: false, label: 'Live Mode' },
    showPhysics: { value: false, label: 'Show Physics' }
  });
  const isLive = isLiveMode;
  const orbitControlsRef = useRef<any>(null);

  useEffect(() => {
    const restoreFocus = () => { window.focus(); if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur(); };
    restoreFocus(); const timer = setTimeout(restoreFocus, 100); return () => clearTimeout(timer);
  }, [isLiveMode]);

  return (
    <KeyboardControls map={keyboardMap}>
      <Canvas shadows onPointerDown={() => { window.focus(); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }}>
        <fogExp2 attach="fog" args={['#503857', 0.0128]} />
        <ambientLight intensity={0.54} color="#e8aa81" />
        <directionalLight position={[50, 35, 15]} intensity={1.8} castShadow shadow-mapSize={[2048, 2048]}>
          <orthographicCamera attach="shadow-camera" args={[-50, 50, 50, -50]} />
        </directionalLight>
        <OrthographicCamera makeDefault position={[START_POSITION[0] + 20, START_POSITION[1] + 20, START_POSITION[2] + 20]} zoom={40} near={0.1} far={1000} onUpdate={c => { if (!isLive) c.lookAt(START_POSITION[0], START_POSITION[1], START_POSITION[2]) }} />
        {!isLive && <OrbitControls ref={orbitControlsRef} target={new Vector3(...START_POSITION)} enableZoom={true} enableRotate={true} maxPolarAngle={Math.PI / 2.1} />}

        <Physics debug={!isLive && showPhysics}>
          <Suspense fallback={null}>
            <Level />
            <Player isLive={isLive} orbitControlsRef={orbitControlsRef} />
          </Suspense>
        </Physics>
        <color attach="background" args={['#200a0a']} />
      </Canvas>
    </KeyboardControls>
  );
}